import React from 'react';
import { Check, Circle, ArrowRight } from 'lucide-react';

/** A record's progress is derived from its authoritative state, never saved a second time. */
export default function WorkflowChecklist({ title, steps }) {
  const current = steps.findIndex(step => !step.done && !step.skipped);
  return <section className="workflow-checklist" aria-label={title}>
    <header><div><span className="section-kicker">What happens next</span><h3>{title}</h3></div>
      <small>{steps.filter(step => step.done).length} of {steps.filter(step => !step.skipped).length} complete</small></header>
    <ol>{steps.map((step, index) => <li key={step.label} className={step.skipped ? 'future skipped' : step.done ? 'done' : index === current ? 'current' : 'future'}>
      <span className="workflow-checklist-marker" aria-hidden="true">{step.done ? <Check size={14} /> : <Circle size={12} />}</span>
      <div><strong>{step.label}</strong><small>{step.owner ? `${step.owner} · ` : ''}{step.detail}</small></div>
      {index === current && step.href && <a href={step.href} aria-label={`${step.action || 'Open'}: ${step.label}`}>{step.action || 'Open'} <ArrowRight size={14} /></a>}
    </li>)}</ol>
  </section>;
}
