import React, { useEffect, useState } from 'react';
import { api, inr, inputToPaise, inputToScaled, scaledToInput } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Loading, Modal, Select, Table, Tabs, Textarea, useAsync, useToast } from '../components.jsx';

const ADJUSTMENT_TYPES = [
  ['adjustment_increase', 'Increase (found / correction, needs valuation)'],
  ['adjustment_decrease', 'Decrease (count correction)'],
  ['wastage', 'Wastage'],
  ['damage', 'Damage'],
  ['expiry_writeoff', 'Expiry write-off'],
  ['internal_consumption', 'Internal consumption'],
];

const BATCH_STATUS = ['saleable', 'quarantine', 'recalled', 'expired', 'blocked'];

export default function Inventory() {
  const { can, session } = useSession();
  const { push } = useToast();
  const [tab, setTab] = useState('stock');
  const stock = useAsync(() => api('/stock'), []);
  const products = useAsync(() => api('/products?includeArchived=false'), []);
  const movements = useAsync(() => api('/stock/movements'), []);
  const [adjustOpen, setAdjustOpen] = useState(null);
  const [adjustForm, setAdjustForm] = useState({ type: 'wastage', quantity: '', unitCost: '', reason: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newProduct, setNewProduct] = useState(null);
  const [statusEdit, setStatusEdit] = useState(null);

  function openAdjust(row) {
    setAdjustForm({ type: 'wastage', quantity: '', unitCost: '', reason: '' });
    setError(null);
    setAdjustOpen(row);
  }

  async function submitAdjustment(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const product = (products.data?.products || []).find((p) => p.id === adjustOpen.productId);
      const body = {
        branchId: session?.branch?.id,
        productId: adjustOpen.productId,
        batchId: adjustOpen.batchId,
        type: adjustForm.type,
        quantityScaled: inputToScaled(adjustForm.quantity, product?.quantityScale ?? adjustOpen.quantityScale ?? 0),
        reason: adjustForm.reason,
      };
      if (adjustForm.type === 'adjustment_increase') {
        body.unitCostPaise = inputToPaise(adjustForm.unitCost || '0');
      }
      await api('/stock/adjustments', { method: 'POST', body });
      push('Stock adjustment posted');
      setAdjustOpen(null);
      stock.reload();
      movements.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitStatus(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/batches/${statusEdit.batchId}/status`, { method: 'POST', body: { status: statusEdit.status, reason: statusEdit.reason } });
      push('Batch status updated');
      setStatusEdit(null);
      stock.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function createProduct(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: newProduct.name,
        kind: newProduct.kind,
        category: newProduct.category,
        sku: newProduct.sku || null,
        uom: newProduct.uom,
        quantityScale: Number(newProduct.quantityScale || 0),
        salePricePaise: inputToPaise(newProduct.price || '0'),
        priceMode: newProduct.priceMode,
        taxTreatment: newProduct.taxTreatment,
        taxRateBps: newProduct.taxTreatment === 'taxable' ? String(Math.round(Number(newProduct.rate || 0) * 100)) : '0',
        hsn: newProduct.hsn || null,
        mrpPaise: newProduct.mrp ? inputToPaise(newProduct.mrp) : null,
        prescriptionRequired: Boolean(newProduct.prescriptionRequired),
        schedule: newProduct.schedule || null,
      };
      const created = await api('/products', { method: 'POST', body });
      await api(`/products/${created.product?.id || created.product?._id}/classification-review`, {
        method: 'POST',
        body: { evidence: newProduct.evidence, hsn: body.hsn, taxRateBps: body.taxRateBps, taxTreatment: body.taxTreatment },
      });
      push('Product created and classification reviewed');
      setNewProduct(null);
      products.reload();
      stock.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'stock', label: 'Stock & batches' },
          { key: 'products', label: 'Catalogue' },
          { key: 'movements', label: 'Movements' },
        ]}
      />

      {tab === 'stock' && (
        <Card
          title="Stock by batch"
          subtitle="Quantity-only roles never receive cost or valuation fields."
          actions={<Button size="sm" variant="ghost" onClick={stock.reload}>Refresh</Button>}
        >
          {stock.loading ? (
            <Loading />
          ) : (
            <>
              <ErrorNotice error={stock.error} />
              <Table
                columns={[
                  { key: 'product', label: 'Product' },
                  { key: 'batchNo', label: 'Batch' },
                  {
                    key: 'expiry',
                    label: 'Expiry',
                    render: (r) => (r.expiry ? `${r.expiry.date || `${r.expiry.year}-${String(r.expiry.month || '').padStart(2, '0')}`} (${r.expiry.precision})` : '—'),
                  },
                  { key: 'status', label: 'Status', render: (r) => <Chip tone={r.status === 'saleable' ? 'good' : 'warn'}>{r.status}</Chip> },
                  { key: 'available', label: 'Available', align: 'right' },
                  { key: 'nonSaleable', label: 'Non-saleable', align: 'right' },
                  ...(stock.data?.quantityOnly ? [] : [{ key: 'costPoolPaise', label: 'Cost pool', align: 'right', render: (r) => <span className="mono">{inr(r.costPoolPaise)}</span> }]),
                  {
                    key: 'actions',
                    label: '',
                    render: (r) => (
                      <div className="row gap-s">
                        {can('inventory.adjust') && (
                          <Button size="sm" variant="ghost" onClick={() => openAdjust(r)}>
                            Adjust
                          </Button>
                        )}
                        {can('inventory.manage') && (
                          <Button size="sm" variant="ghost" onClick={() => setStatusEdit({ batchId: r.batchId, status: r.status, reason: '' })}>
                            Status
                          </Button>
                        )}
                      </div>
                    ),
                  },
                ]}
                rows={stock.data?.rows || []}
                rowKey={(r) => r.batchId}
                empty="No batches yet. Post a supplier bill to receive stock."
              />
            </>
          )}
        </Card>
      )}

      {tab === 'products' && (
        <Card
          title="Catalogue"
          subtitle="A product cannot be billed until its classification (HSN, rate, treatment) is reviewed."
          actions={
            can('products.manage') ? (
              <Button size="sm" onClick={() => { setError(null); setNewProduct({ kind: 'goods', uom: 'unit', quantityScale: 0, priceMode: 'inclusive', taxTreatment: 'taxable', rate: '12', evidence: '' }); }}>
                New product
              </Button>
            ) : null
          }
        >
          {products.loading ? (
            <Loading />
          ) : (
            <>
              <ErrorNotice error={products.error} />
              <Table
                columns={[
                  { key: 'name', label: 'Product' },
                  { key: 'kind', label: 'Kind' },
                  { key: 'category', label: 'Category' },
                  { key: 'hsn', label: 'HSN/SAC' },
                  { key: 'tax', label: 'GST', render: (p) => (p.taxTreatment === 'taxable' ? `${Number(p.taxRateBps) / 100}%` : p.taxTreatment.replace('_', ' ')) },
                  { key: 'salePricePaise', label: 'Price', align: 'right', render: (p) => <span className="mono">{inr(p.salePricePaise)}</span> },
                  { key: 'reviewed', label: 'Reviewed', render: (p) => <Chip tone={p.classificationReviewed ? 'good' : 'bad'}>{p.classificationReviewed ? 'yes' : 'pending'}</Chip> },
                  { key: 'restrictions', label: 'Restriction', render: (p) => (p.restrictions?.blocked ? <Chip tone="bad">{p.restrictions.schedule || 'blocked'}</Chip> : <span className="muted">—</span>) },
                ]}
                rows={products.data?.products || []}
                rowKey={(p) => p.id}
                empty="No products yet."
              />
              {!products.data?.canSeeCost && <p className="muted small">Cost and margin values are withheld for your role.</p>}
            </>
          )}
        </Card>
      )}

      {tab === 'movements' && (
        <Card title="Inventory movements" subtitle="Every movement carries its source document and actor." actions={<Button size="sm" variant="ghost" onClick={movements.reload}>Refresh</Button>}>
          {movements.loading ? (
            <Loading />
          ) : (
            <Table
              dense
              columns={[
                { key: 'at', label: 'When', render: (m) => new Date(m.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) },
                { key: 'type', label: 'Type' },
                { key: 'productId', label: 'Product', render: (m) => (products.data?.products || []).find((p) => p.id === m.productId)?.name || m.productId },
                { key: 'quantityScaled', label: 'Qty', align: 'right', render: (m) => scaledToInput(m.quantityScaled, m.quantityScale ?? 0) },
                { key: 'sourceType', label: 'Source' },
                { key: 'reason', label: 'Reason', render: (m) => m.reason || '—' },
              ]}
              rows={movements.data?.movements || []}
              rowKey={(m) => m._id}
            />
          )}
        </Card>
      )}

      {adjustOpen && (
        <Modal title={`Stock adjustment — ${adjustOpen.product}`} onClose={() => setAdjustOpen(null)}>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <form onSubmit={submitAdjustment} className="col gap">
            <Field label="Type">
              <Select value={adjustForm.type} onChange={(e) => setAdjustForm({ ...adjustForm, type: e.target.value })}>
                {ADJUSTMENT_TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Quantity (${adjustOpen.uom})`} required>
              <Input value={adjustForm.quantity} onChange={(e) => setAdjustForm({ ...adjustForm, quantity: e.target.value })} inputMode="decimal" required />
            </Field>
            {adjustForm.type === 'adjustment_increase' && (
              <Field label="Valuation per unit ₹" hint="Found stock needs an explicit value; it is not invented from the sale price." required>
                <Input value={adjustForm.unitCost} onChange={(e) => setAdjustForm({ ...adjustForm, unitCost: e.target.value })} inputMode="decimal" required />
              </Field>
            )}
            <Field label="Reason" required hint="At least 5 characters; recorded in the audit trail.">
              <Textarea value={adjustForm.reason} onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })} minLength={5} required />
            </Field>
            <Button type="submit" busy={busy}>
              Post adjustment
            </Button>
          </form>
        </Modal>
      )}

      {statusEdit && (
        <Modal title="Change batch status" onClose={() => setStatusEdit(null)}>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <Banner tone="warn" title="Quarantined or recalled batches are never saleable">
            Status changes are audited. They do not move stock by themselves.
          </Banner>
          <form onSubmit={submitStatus} className="col gap">
            <Field label="Status">
              <Select value={statusEdit.status} onChange={(e) => setStatusEdit({ ...statusEdit, status: e.target.value })}>
                {BATCH_STATUS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason" required>
              <Input value={statusEdit.reason} onChange={(e) => setStatusEdit({ ...statusEdit, reason: e.target.value })} minLength={5} required />
            </Field>
            <Button type="submit" busy={busy}>
              Save status
            </Button>
          </form>
        </Modal>
      )}

      {newProduct && (
        <Modal title="New product" onClose={() => setNewProduct(null)} wide>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <form onSubmit={createProduct} className="col gap">
            <div className="grid grid-form">
              <Field label="Name" required>
                <Input value={newProduct.name || ''} onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })} required />
              </Field>
              <Field label="Kind">
                <Select value={newProduct.kind} onChange={(e) => setNewProduct({ ...newProduct, kind: e.target.value })}>
                  <option value="goods">Goods (batch + expiry)</option>
                  <option value="service">Service</option>
                </Select>
              </Field>
              <Field label="Category">
                <Input value={newProduct.category || ''} onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })} />
              </Field>
              <Field label="SKU">
                <Input value={newProduct.sku || ''} onChange={(e) => setNewProduct({ ...newProduct, sku: e.target.value })} />
              </Field>
              <Field label="Unit">
                <Select value={newProduct.uom} onChange={(e) => setNewProduct({ ...newProduct, uom: e.target.value })}>
                  {['unit', 'strip', 'tablet', 'bottle', 'ml', 'gm', 'kg', 'ltr', 'vial', 'sachet', 'box', 'pack', 'service'].map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Quantity decimals">
                <Select value={String(newProduct.quantityScale)} onChange={(e) => setNewProduct({ ...newProduct, quantityScale: Number(e.target.value) })}>
                  {[0, 1, 2, 3].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="HSN / SAC" hint="4, 6 or 8 digits">
                <Input value={newProduct.hsn || ''} onChange={(e) => setNewProduct({ ...newProduct, hsn: e.target.value })} />
              </Field>
              <Field label="Sale price ₹" required>
                <Input value={newProduct.price || ''} onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })} inputMode="decimal" required />
              </Field>
              <Field label="Price includes GST">
                <Select value={newProduct.priceMode} onChange={(e) => setNewProduct({ ...newProduct, priceMode: e.target.value })}>
                  <option value="inclusive">Yes — inclusive</option>
                  <option value="exclusive">No — exclusive</option>
                </Select>
              </Field>
              <Field label="Tax treatment">
                <Select value={newProduct.taxTreatment} onChange={(e) => setNewProduct({ ...newProduct, taxTreatment: e.target.value })}>
                  <option value="taxable">Taxable</option>
                  <option value="exempt">Exempt</option>
                  <option value="nil_rated">Nil rated</option>
                  <option value="zero_rated">Zero rated</option>
                  <option value="out_of_scope">Out of scope</option>
                </Select>
              </Field>
              {newProduct.taxTreatment === 'taxable' && (
                <Field label="GST rate %">
                  <Select value={String(newProduct.rate)} onChange={(e) => setNewProduct({ ...newProduct, rate: e.target.value })}>
                    {['0.25', '3', '5', '12', '18', '28'].map((r) => (
                      <option key={r} value={r}>
                        {r}%
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="MRP ₹" hint="Optional; MRP ceilings are gated separately.">
                <Input value={newProduct.mrp || ''} onChange={(e) => setNewProduct({ ...newProduct, mrp: e.target.value })} inputMode="decimal" />
              </Field>
              <Field label="Drug schedule" hint="H1/X/NDPS products are blocked from billing until the approved process exists.">
                <Select value={newProduct.schedule || ''} onChange={(e) => setNewProduct({ ...newProduct, schedule: e.target.value })}>
                  <option value="">None</option>
                  <option value="H">Schedule H</option>
                  <option value="H1">Schedule H1</option>
                  <option value="X">Schedule X</option>
                  <option value="NDPS">NDPS</option>
                </Select>
              </Field>
            </div>
            <Field label="Classification review evidence" required hint="Who checked the HSN/rate and against what (e.g. CA note, product label).">
              <Input value={newProduct.evidence} onChange={(e) => setNewProduct({ ...newProduct, evidence: e.target.value })} minLength={5} required />
            </Field>
            <Button type="submit" busy={busy}>
              Create and mark reviewed
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
