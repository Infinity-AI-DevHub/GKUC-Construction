import React from 'react';
import {AlertTriangle} from 'lucide-react';
import {FEATURE_LABELS,PAUSE_ERROR,PAUSE_DETAIL,PAUSE_SOLUTION} from '../../backend/src/lib/temporary-features.mjs';
export default function TemporaryFeatureNotice({feature}) {
 return <section className="workspace-surface" role="alert" aria-label={`${FEATURE_LABELS[feature]} error`}>
  <AlertTriangle size={28} aria-hidden="true"/><h2>{PAUSE_ERROR}</h2><p>{PAUSE_DETAIL}</p>
  <h3>Solution</h3><p>{PAUSE_SOLUTION}</p>
 </section>;
}
