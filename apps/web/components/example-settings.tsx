import { hideExampleAction, resetExampleAction } from '@/actions/example';

/** Settings section for the built-in example: state, Hide (when shown) and Reset. Plain forms, no JS needed. */
export function ExampleSettings({ hidden }: { hidden: boolean }) {
  return (
    <section aria-labelledby="example-title" className="card" data-tour="settings-example" data-testid="example-settings">
      <h2 id="example-title">Example case</h2>
      <p>
        Status: <strong>{hidden ? 'Hidden' : 'Shown'}</strong>
      </p>
      <div className="example-actions">
        {hidden ? null : (
          <form action={hideExampleAction}>
            <button type="submit" className="secondary">
              Hide example case
            </button>
          </form>
        )}
        <form action={resetExampleAction}>
          <button type="submit" className="secondary">
            Reset example case
          </button>
        </form>
      </div>
      <p className="muted small">Restores the example and shows it again; your practice scores and notes on it are removed.</p>
    </section>
  );
}
