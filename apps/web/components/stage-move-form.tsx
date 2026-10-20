'use client';

import type { CaseStage } from '@bcg/core/db/schema';
import { useActionState, useState } from 'react';
import { moveStageAction, overturnKillAction } from '@/actions/stage';
import type { FormState } from '@/lib/form';
import { STAGES, STAGE_LABEL } from '@/lib/stages';

/**
 * Move a case to another stage: a select of the other stages, a note (required to kill; checked on the server, hinted
 * here) and a submit button. Works without JS. A killed case also gets an "Overturn kill" button (killed → new).
 * `returnTo` (a same-origin path, checked again on the server) is where both forms land after a successful action.
 */
export function StageMoveForm({ caseId, slug, stage, returnTo }: { caseId: string; slug: string; stage: CaseStage; returnTo?: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(moveStageAction, {});
  const others = STAGES.filter((s) => s !== stage);
  const [to, setTo] = useState<CaseStage>(others[0]!);
  const killing = to === 'killed';

  return (
    <div className="stage-move">
      <form action={formAction} data-testid="move-stage" className="stage-move-form">
        <input type="hidden" name="caseId" value={caseId} />
        <input type="hidden" name="from" value={stage} />
        <input type="hidden" name="slug" value={slug} />
        {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
        <label className="visually-hidden" htmlFor={`to-${caseId}`}>
          Move to
        </label>
        <select id={`to-${caseId}`} name="to" value={to} onChange={(e) => setTo(e.target.value as CaseStage)}>
          {others.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor={`note-${caseId}`}>
          Note
        </label>
        <input
          id={`note-${caseId}`}
          type="text"
          name="note"
          maxLength={500}
          required={killing}
          placeholder={killing ? 'Why kill it? (required)' : 'Note (optional; required to kill)'}
        />
        <button type="submit" disabled={pending}>
          {pending ? 'Moving…' : 'Move'}
        </button>
      </form>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {stage === 'killed' ? (
        <form action={overturnKillAction} data-testid="overturn-kill">
          <input type="hidden" name="caseId" value={caseId} />
          <input type="hidden" name="slug" value={slug} />
          {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
          <button type="submit" className="secondary">
            Overturn kill
          </button>
        </form>
      ) : null}
    </div>
  );
}
