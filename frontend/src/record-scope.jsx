import React, { createContext, useContext } from 'react';
import { Building2, Boxes } from 'lucide-react';
import { notice } from './notices.js';

const ScopeContext = createContext(null);

export function RecordScopeProvider({ scope, children }) {
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

export function useRecordScope(override) {
  const inherited = useContext(ScopeContext);
  return override || inherited;
}

export function RecordScopeBadge({ scope, compact = false }) {
  const resolved = useRecordScope(scope);
  if (!resolved) return null;
  const shared = resolved.kind === 'shared';
  const text = shared ? 'Shared resource' : resolved.name || 'Select a company';
  return <span className={`record-scope-badge ${shared ? 'is-shared' : 'is-company'}${compact ? ' is-compact' : ''}`} title={shared ? 'Used by both GKUC companies' : `This record belongs to ${text}`}>
    {shared ? <Boxes size={14} /> : <Building2 size={14} />}{text}
  </span>;
}

export function showScopeSaved(scope) {
  if (!scope) return;
  const shared = scope.kind === 'shared';
  notice({ severity: 'Info', title: shared ? 'Shared record saved' : `Saved for ${scope.name}`,
    message: shared ? 'This resource is available to both GKUC companies. No company ledger was changed by saving this record.'
      : `This record belongs to ${scope.name}. Related financial entries affect the ${scope.name} ledger only.` });
}
