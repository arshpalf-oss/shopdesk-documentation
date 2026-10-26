import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setCsrfToken } from './api.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, session: null, error: null });

  const refresh = useCallback(async () => {
    try {
      const session = await api('/session');
      if (session.csrfToken) setCsrfToken(session.csrfToken);
      setState({ loading: false, session, error: null });
      return session;
    } catch (error) {
      setState({ loading: false, session: null, error });
      throw error;
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const value = useMemo(() => {
    const session = state.session;
    const permissions = session?.permissions;
    return {
      ...state,
      session,
      refresh,
      can(permission) {
        if (!permission) return true;
        if (!permissions) return false;
        if (permissions.can && permission in permissions.can) return Boolean(permissions.can[permission]);
        return Array.isArray(permissions.permissions) && permissions.permissions.includes('*');
      },
      tenant: session?.tenant || null,
      branch: session?.branch || null,
    };
  }, [state, refresh]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
