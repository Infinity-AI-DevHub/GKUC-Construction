import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, X, Check } from 'lucide-react';
import { post } from './api.js';

/*
 * The introduction somebody gets the first time they sign in.
 *
 * It moves through the real screens rather than describing them in the abstract: each step
 * navigates to the page it is talking about, so the explanation sits over the thing itself.
 * A person who has just been handed a login is not learning a diagram, they are learning
 * where their work lives.
 *
 * Only sections they can actually open are included. Being walked past a screen that
 * answers "you do not have permission" teaches nothing and reads as the system being
 * broken, so a store keeper's tour is shorter than the Managing Director's — and that is
 * the correct tour, not an abbreviated one.
 */

/*
 * Written for somebody who has not used the system before, and in many cases has not used
 * software like it before. Each step says what the screen is for, not what it contains.
 */
const STEPS = [
  {
    key: 'welcome',
    title: name => `Welcome, ${name.split(' ')[0]}`,
    body: role => `You are signed in as ${role}. This is GKUC SiteOps — where the company keeps `
      + 'its projects, people, materials and money in one place, so everybody is working from '
      + 'the same information.\n\nThis short introduction takes about a minute. You can leave it '
      + 'at any point, and start it again later from your name in the top corner.'
  },
  {
    key: 'Dashboard', page: 'Dashboard',
    title: () => 'Start here each morning',
    body: () => 'The dashboard is the first thing you see when you sign in. It shows what needs '
      + 'attention today — work that is behind, materials running low, papers about to expire.'
      + '\n\nIf nothing here is asking for you, the day is in order.'
  },
  {
    key: 'Projects', page: 'Projects', permission: 'projects.view',
    title: () => 'Every project the company is running',
    body: () => 'Each project holds its own budget, programme, team, photographs and documents. '
      + 'Open one to see how it is progressing and what has been spent against it.'
  },
  {
    key: 'Tasks', page: 'Tasks', permission: 'site.tasks',
    title: () => 'Who is doing what, and by when',
    body: () => 'Tasks are assigned to a person with a date. When you finish one, mark it here — '
      + 'that is what tells everybody else it is done, without a phone call.'
  },
  {
    key: 'Daily reports', page: 'Daily reports', permission: 'site.reports',
    title: () => 'The record of each day on site',
    body: () => 'A short report each day: what was done, who was there, what the weather was, '
      + 'anything that held the work up. It takes a couple of minutes and it is the record the '
      + 'company relies on months later when somebody asks what happened.'
  },
  {
    key: 'Quantity Surveying', page: 'Quantity Surveying', permission: 'qs.view',
    title: () => 'Bills, quotations and tenders',
    body: () => 'Bills of quantities are priced here, and quotations and invoices are built from '
      + 'them. You can type a bill in directly or upload one from Excel — including a bill sent '
      + 'to you by another company, in their own layout.'
  },
  {
    key: 'People', page: 'People', permission: 'hr.view',
    title: () => 'Staff, attendance and payroll',
    body: () => 'Employee records, who was on site, leave requests and pay. Attendance can be '
      + 'imported from the fingerprint machine rather than typed in.'
  },
  {
    key: 'Materials', page: 'Materials', permission: 'store.view',
    title: () => 'What is in the store',
    body: () => 'Stock levels, what has been issued to which site, and what is running low. '
      + 'The system warns you before something runs out rather than after.'
  },
  {
    key: 'Fleet', page: 'Fleet', permission: 'transport.view',
    title: () => 'Vehicles and machines',
    body: () => 'Where each vehicle is, when its insurance and licence expire, and what '
      + 'maintenance it has had. Expiry dates are watched for you.'
  },
  {
    key: 'Finance', page: 'Finance', permission: 'finance.view',
    title: () => 'Money in and money out',
    body: () => 'Costs recorded against each project, income received, and supplier invoices. '
      + 'This is what makes the budget figures on the dashboard mean something.'
  },
  {
    key: 'alerts',
    title: () => 'The system tells you when something needs you',
    body: () => 'The bell at the top carries anything addressed to you — a deadline approaching, '
      + 'a document expiring, a task assigned. Important ones also appear as a message on screen '
      + 'with a sound, and can be sent to your phone on WhatsApp.'
      + '\n\nThe speaker beside the bell turns the sound off if you would rather it was quiet.'
  },
  {
    key: 'search',
    title: () => 'Looking for something',
    body: () => 'The magnifying glass at the top searches inside documents — not just their '
      + 'names. If you remember a supplier or a figure but not which of forty scans it was in, '
      + 'that is what finds it.'
  },
  {
    key: 'done',
    title: () => 'That is the tour',
    body: () => 'You will not be shown this again. If you want it back, click your name in the '
      + 'top corner and choose "Show me around again".'
      + '\n\nIf something looks wrong, it is worth saying so rather than working around it — a '
      + 'figure that is wrong here becomes a figure that is wrong on an invoice.'
  }
];

export default function Tour({ user, can, onNavigate, onClose }) {
  const steps = useMemo(
    () => STEPS.filter(step => !step.permission || can.has(step.permission)),
    [can]
  );
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const last = index === steps.length - 1;

  /* Each step shows the screen it is describing, so the words sit over the real thing. */
  useEffect(() => {
    if (step?.page) onNavigate(step.page);
  }, [step?.page, onNavigate]);

  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight' && !last) setIndex(i => i + 1);
      if (event.key === 'ArrowLeft' && index > 0) setIndex(i => i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, last, onClose]);

  if (!step) return null;

  const finish = async () => {
    /* Recorded on the account, so it does not reappear on another device. */
    await post('/auth/tour-seen').catch(() => {});
    onClose();
  };

  return createPortal(
    <div className="tour-backdrop" role="dialog" aria-modal="true" aria-label="Introduction to SiteOps">
      <div className="tour">
        <div className="tour-head">
          <span className="tour-count">Step {index + 1} of {steps.length}</span>
          <button type="button" onClick={finish} className="tour-skip" aria-label="Close the introduction">
            <X size={17} />
          </button>
        </div>

        <h2>{step.title(user.name, user.role)}</h2>
        {step.body(user.role).split('\n\n').map((paragraph, position) => (
          <p key={position}>{paragraph}</p>
        ))}

        <div className="tour-dots" aria-hidden="true">
          {steps.map((one, position) => (
            <i key={one.key} className={position === index ? 'is-here' : position < index ? 'is-done' : ''} />
          ))}
        </div>

        <div className="tour-actions">
          {/* On the last step "Finish" already closes it; offering "Close" beside it is two
              buttons doing one thing, which makes a person stop and wonder which is which. */}
          {last
            ? <span />
            : <button type="button" className="secondary" onClick={finish}>Skip the introduction</button>}
          <div className="tour-move">
            {index > 0 && (
              <button type="button" className="secondary" onClick={() => setIndex(i => i - 1)}>
                <ArrowLeft size={16} /> Back
              </button>
            )}
            {last
              ? <button type="button" className="primary" onClick={finish}><Check size={16} /> Finish</button>
              : <button type="button" className="primary" onClick={() => setIndex(i => i + 1)}>
                Next <ArrowRight size={16} />
              </button>}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
