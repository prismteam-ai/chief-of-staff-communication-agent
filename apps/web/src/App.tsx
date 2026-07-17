import { useEffect, useMemo, useState } from 'react';

import { createBrowserApi } from '@chief/browser-api';
import { foundationCapabilities, type HealthResponse } from '@chief/contracts';

type ApiState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly health: HealthResponse }
  | { readonly kind: 'unavailable' };

const labels: Record<(typeof foundationCapabilities)[number], string> = {
  connectors: 'Connectors',
  oauth: 'OAuth',
  rag: 'RAG',
  actions: 'Actions',
  agents: 'Agents',
};

export function App() {
  const api = useMemo(
    () => createBrowserApi(import.meta.env.VITE_API_BASE_URL ?? ''),
    [],
  );
  const [apiState, setApiState] = useState<ApiState>({ kind: 'checking' });

  useEffect(() => {
    let active = true;

    void api.systemHealth().then(
      (health) => {
        if (active) setApiState({ kind: 'ready', health });
      },
      () => {
        if (active) setApiState({ kind: 'unavailable' });
      },
    );

    return () => {
      active = false;
    };
  }, [api]);

  const statusLabel =
    apiState.kind === 'ready'
      ? 'API healthy'
      : apiState.kind === 'checking'
        ? 'Checking API'
        : 'API not connected';

  return (
    <main className="shell">
      <nav className="topbar" aria-label="Product status">
        <a className="brand" href="#top" aria-label="Chief home">
          <span className="brand-mark">C</span>
          <span>Chief</span>
        </a>
        <span className={`health health--${apiState.kind}`}>
          <span className="health-dot" aria-hidden="true" />
          {statusLabel}
        </span>
      </nav>

      <section id="top" className="hero">
        <div className="eyebrow">COS-010 · Foundation</div>
        <h1>
          Executive communications,
          <br />
          built on a clear boundary.
        </h1>
        <p className="lede">
          The typed web, API, worker, MCP, and AWS deployment surfaces are in
          place. Product capabilities remain intentionally disabled until their
          contracts and safety controls are implemented.
        </p>
        <div className="hero-meta">
          <span>Node 22</span>
          <span>TypeScript</span>
          <span>tRPC + Lambda</span>
          <span>AWS CDK</span>
        </div>
      </section>

      <section className="panel" aria-labelledby="capability-heading">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Capability boundary</p>
            <h2 id="capability-heading">Honest foundation status</h2>
          </div>
          <span className="foundation-badge">Foundation only</span>
        </div>

        <div className="capability-grid">
          {foundationCapabilities.map((capability, index) => (
            <article className="capability" key={capability}>
              <span className="capability-index">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div>
                <h3>{labels[capability]}</h3>
                <p>Not implemented yet</p>
              </div>
              <span className="pending-dot" aria-hidden="true" />
            </article>
          ))}
        </div>
      </section>

      <section className="status-grid" aria-label="Foundation surfaces">
        <article className="status-card status-card--accent">
          <p className="section-kicker">Runtime</p>
          <h2>Typed health path</h2>
          <p>
            Browser → shared client → tRPC <code>system.health</code> → Lambda.
          </p>
          <div className="runtime-status">
            <span className={`health-dot health-dot--${apiState.kind}`} />
            {statusLabel}
          </div>
        </article>

        <article className="status-card">
          <p className="section-kicker">Safety</p>
          <h2>Effects disabled</h2>
          <p>
            Ingestion and execution workers are non-effectful. No connector,
            credential, queue, database, model, send, or task integration
            exists.
          </p>
        </article>

        <article className="status-card">
          <p className="section-kicker">MCP</p>
          <h2>Truthful by default</h2>
          <p>
            Health is available; every non-health MCP request returns
            <code>501 MCP_FOUNDATION_ONLY</code>.
          </p>
        </article>
      </section>

      <footer>
        <span>Chief of Staff Communication Agent</span>
        <span>Foundation ready for the first graded vertical</span>
      </footer>
    </main>
  );
}
