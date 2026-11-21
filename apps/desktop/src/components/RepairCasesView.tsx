import React, { useEffect, useState } from 'react';
import { DollarSign, Plus, Trash2, Wrench } from 'lucide-react';
import { apiRequest } from '../api';

interface RepairCaseSummary {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  title: string;
  symptomSummary: string;
  diagnosisSummary: string;
  resolutionNotes: string;
  priority: string;
  status: string;
  totalExpense: number;
  entryCount: number;
  updatedAt: string;
}

function formatStatus(status: string): string {
  const spaced = status.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function statusPillClass(status: string): string {
  switch (status) {
    case 'resolved':
    case 'closed':
      return 'bg-[var(--cs-ok-soft)] text-[var(--cs-ok-ink)] border-[var(--cs-ok-border)]';
    case 'waiting_parts':
    case 'referred_pro':
      return 'bg-[var(--cs-warn-soft)] text-[var(--cs-warn-ink)] border-[var(--cs-warn-border)]';
    default:
      return 'bg-[var(--cs-accent-soft)] text-[var(--cs-accent-ink)] border-[var(--cs-accent-border)]';
  }
}

export const RepairCasesView: React.FC<{ devices: Array<{ id: string; name: string }> }> = ({ devices }) => {
  const [cases, setCases] = useState<RepairCaseSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    repairCase: RepairCaseSummary;
    entries: Array<{ id: string; entry_type: string; title: string; body: string; measurement_value?: string; created_at: string }>;
    expenses: Array<{ id: string; item_name: string; category: string; amount: number; currency: string; vendor?: string }>;
  } | null>(null);

  const [newTitle, setNewTitle] = useState('');
  const [newDeviceId, setNewDeviceId] = useState('');
  const [newSymptom, setNewSymptom] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const [entryTitle, setEntryTitle] = useState('');
  const [entryBody, setEntryBody] = useState('');
  const [entryVal, setEntryVal] = useState('');
  const [expName, setExpName] = useState('');
  const [expAmount, setExpAmount] = useState('');

  const loadCases = async () => {
    const res = await apiRequest<{ cases: RepairCaseSummary[] }>('/api/v1/cases');
    setCases(res.cases);
    if (!selectedId && res.cases.length > 0) setSelectedId(res.cases[0].id);
  };

  const loadDetail = async (id: string) => {
    const res = await apiRequest<typeof detail>(`/api/v1/cases/${id}`);
    setDetail(res);
  };

  useEffect(() => {
    loadCases().catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId).catch(() => {});
    else setDetail(null);
  }, [selectedId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await apiRequest<{ repairCase: { id: string } }>('/api/v1/cases', {
      method: 'POST',
      body: { title: newTitle, deviceId: newDeviceId || undefined, symptomSummary: newSymptom },
    });
    setNewTitle('');
    setNewSymptom('');
    setShowCreate(false);
    await loadCases();
    setSelectedId(res.repairCase.id);
  };

  const handleStatusChange = async (status: string) => {
    if (!selectedId) return;
    await apiRequest(`/api/v1/cases/${selectedId}`, { method: 'PATCH', body: { status } });
    await loadCases();
    await loadDetail(selectedId);
  };

  const handleAddEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId) return;
    await apiRequest(`/api/v1/cases/${selectedId}/entries`, {
      method: 'POST',
      body: {
        entryType: entryVal ? 'measurement' : 'note',
        title: entryTitle,
        body: entryBody,
        measurementValue: entryVal || undefined,
      },
    });
    setEntryTitle('');
    setEntryBody('');
    setEntryVal('');
    await loadDetail(selectedId);
    await loadCases();
  };

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || !expName || !expAmount) return;
    await apiRequest(`/api/v1/cases/${selectedId}/expenses`, {
      method: 'POST',
      body: { itemName: expName, amount: Number(expAmount), category: 'part' },
    });
    setExpName('');
    setExpAmount('');
    await loadDetail(selectedId);
    await loadCases();
  };

  const handleDelete = async (id: string) => {
    await apiRequest(`/api/v1/cases/${id}`, { method: 'DELETE' });
    if (selectedId === id) setSelectedId(null);
    await loadCases();
  };

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-[var(--cs-border)]">
        <div className="space-y-1">
          <h1 className="cs-heading text-2xl font-bold text-[var(--cs-ink)]">
            Repair cases & bench logbook
          </h1>
          <p className="text-xs text-[var(--cs-ink-muted)]">
            Record step-by-step repair procedures, bench measurements, replacement parts, and final outcomes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((s) => !s)}
          className="cs-btn-primary flex items-center gap-1.5 px-4 py-2 text-xs cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>{showCreate ? 'Close form' : 'New repair case'}</span>
        </button>
      </div>

      {/* Collapsible New Repair Case Form */}
      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="cs-panel p-4 grid grid-cols-1 md:grid-cols-3 gap-3 cs-animate-view"
        >
          <input
            required
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Case title (e.g. Repaste heatsink and clean fan)"
            className="cs-input px-3 py-2 text-xs"
          />
          <select
            value={newDeviceId}
            onChange={(e) => setNewDeviceId(e.target.value)}
            className="cs-input px-3 py-2 text-xs"
          >
            <option value="">Link personal device (optional)</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input
              value={newSymptom}
              onChange={(e) => setNewSymptom(e.target.value)}
              placeholder="Initial symptom summary"
              className="cs-input flex-1 px-3 py-2 text-xs"
            />
            <button type="submit" className="cs-btn-accent px-4 text-xs cursor-pointer">
              Create
            </button>
          </div>
        </form>
      )}

      {/* Master-Detail Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left Case Index */}
        <aside className="lg:col-span-4 cs-panel overflow-hidden flex flex-col self-start">
          <div className="px-4 py-3 border-b border-[var(--cs-border)] bg-[var(--cs-chassis)] flex items-center justify-between">
            <h2 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">Cases</h2>
            <span className="font-mono text-[11px] cs-tabular px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-ink-muted)]">
              {cases.length}
            </span>
          </div>

          <div className="divide-y divide-[var(--cs-border)]">
            {cases.length === 0 ? (
              <div className="p-8 text-center text-xs text-[var(--cs-ink-muted)]">
                No repair cases recorded yet. Create one above to track bench notes and part costs.
              </div>
            ) : (
              cases.map((c) => {
                const selected = selectedId === c.id;
                return (
                  <div
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`group relative px-4 py-3.5 cursor-pointer transition-colors ${
                      selected ? 'bg-[var(--cs-accent-soft)]' : 'hover:bg-[var(--cs-canvas)]'
                    }`}
                  >
                    {selected && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--cs-accent)]"
                      />
                    )}
                    <div className="flex justify-between items-start gap-2">
                      <div className="text-xs font-semibold text-[var(--cs-ink)] leading-snug">{c.title}</div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(c.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-[var(--cs-ink-muted)] hover:text-[var(--cs-danger)] transition-opacity cursor-pointer"
                        title="Delete repair case"
                        aria-label="Delete repair case"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                      <span className={`px-2 py-0.5 rounded border font-medium ${statusPillClass(c.status)}`}>
                        {formatStatus(c.status)}
                      </span>
                      <span className="font-mono font-semibold text-[var(--cs-ok-ink)] cs-tabular">
                        ${Number(c.totalExpense || 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Bench Log & Expense Ledger */}
        <section className="lg:col-span-8 space-y-4">
          {!detail ? (
            <div className="cs-panel p-12 text-center text-xs text-[var(--cs-ink-muted)]">
              Select a repair case from the index or create a new one to log bench entries and parts.
            </div>
          ) : (
            <div key={detail.repairCase.id} className="space-y-4 cs-animate-view">
              <div className="cs-panel p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <h2 className="cs-heading text-lg font-bold text-[var(--cs-ink)]">
                    {detail.repairCase.title}
                  </h2>
                  <p className="text-xs text-[var(--cs-ink-muted)]">
                    {detail.repairCase.symptomSummary || 'No initial symptom note recorded'}
                  </p>
                </div>
                <select
                  value={detail.repairCase.status}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  aria-label="Case status"
                  className="cs-input px-3 py-1.5 text-xs font-semibold"
                >
                  <option value="open">Open</option>
                  <option value="investigating">Investigating</option>
                  <option value="waiting_parts">Waiting for parts</option>
                  <option value="resolved">Resolved</option>
                  <option value="referred_pro">Referred to pro</option>
                  <option value="closed">Closed</option>
                </select>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Bench Notes & Measurements */}
                <div className="cs-panel p-4 space-y-4">
                  <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)] flex items-center gap-2">
                    <Wrench className="h-4 w-4 text-[var(--cs-accent)]" />
                    <span>Bench notes & measurements</span>
                  </h3>

                  <form onSubmit={handleAddEntry} className="space-y-2">
                    <input
                      required
                      value={entryTitle}
                      onChange={(e) => setEntryTitle(e.target.value)}
                      placeholder="Entry title (e.g. Heatsink fan dust check)"
                      className="cs-input w-full px-3 py-2 text-xs"
                    />
                    <input
                      value={entryVal}
                      onChange={(e) => setEntryVal(e.target.value)}
                      placeholder="Optional measurement (e.g. Idle 48°C, Load 76°C)"
                      className="cs-input w-full px-3 py-2 text-xs font-mono"
                    />
                    <textarea
                      required
                      rows={2}
                      value={entryBody}
                      onChange={(e) => setEntryBody(e.target.value)}
                      placeholder="Observations or repair steps completed..."
                      className="cs-input w-full px-3 py-2 text-xs"
                    />
                    <button type="submit" className="cs-btn-secondary w-full py-2 text-xs font-semibold cursor-pointer">
                      Add bench entry
                    </button>
                  </form>

                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {detail.entries.length === 0 ? (
                      <div className="text-xs text-[var(--cs-ink-muted)] py-3">
                        No entries logged on this case yet.
                      </div>
                    ) : (
                      detail.entries.map((en) => (
                        <div
                          key={en.id}
                          className="rounded-md bg-[var(--cs-canvas)] p-3 border border-[var(--cs-border)] border-l-[3px] border-l-[var(--cs-accent)] space-y-1"
                        >
                          <div className="flex flex-wrap justify-between gap-2 text-xs">
                            <span className="font-semibold text-[var(--cs-ink)]">{en.title}</span>
                            {en.measurement_value && (
                              <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--cs-accent-soft)] text-[var(--cs-accent-ink)] cs-tabular">
                                {en.measurement_value}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[var(--cs-ink-2)] leading-relaxed">{en.body}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Parts & Expense Ledger */}
                <div className="cs-panel p-4 flex flex-col justify-between gap-4">
                  <div className="space-y-4">
                    <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)] flex items-center gap-2">
                      <DollarSign className="h-4 w-4 text-[var(--cs-ok)]" />
                      <span>Parts & expenses</span>
                    </h3>

                    <form onSubmit={handleAddExpense} className="flex gap-2">
                      <input
                        required
                        value={expName}
                        onChange={(e) => setExpName(e.target.value)}
                        placeholder="Part (e.g. PTM7950 thermal pad)"
                        className="cs-input flex-1 min-w-0 px-3 py-2 text-xs"
                      />
                      <input
                        required
                        type="number"
                        step="0.01"
                        min={0}
                        value={expAmount}
                        onChange={(e) => setExpAmount(e.target.value)}
                        placeholder="USD"
                        className="cs-input w-20 px-2.5 py-2 text-xs font-mono"
                      />
                      <button type="submit" className="cs-btn-accent px-3.5 text-xs cursor-pointer">
                        Add
                      </button>
                    </form>

                    <div className="divide-y divide-[var(--cs-border)] border-t border-[var(--cs-border)]">
                      {detail.expenses.length === 0 ? (
                        <div className="py-4 text-xs text-[var(--cs-ink-muted)]">
                          No parts or labor expenses logged.
                        </div>
                      ) : (
                        detail.expenses.map((ex) => (
                          <div key={ex.id} className="flex justify-between items-center py-2.5 text-xs">
                            <span className="text-[var(--cs-ink)] font-medium">{ex.item_name}</span>
                            <span className="font-mono text-[var(--cs-ok-ink)] cs-tabular">
                              ${ex.amount.toFixed(2)}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="pt-3 border-t-2 border-[var(--cs-border)] flex justify-between items-baseline text-xs">
                    <span className="font-semibold text-[var(--cs-ink-2)]">Total case spend</span>
                    <span className="font-mono text-base font-bold text-[var(--cs-ok)] cs-tabular">
                      ${detail.expenses.reduce((sum, x) => sum + x.amount, 0).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
