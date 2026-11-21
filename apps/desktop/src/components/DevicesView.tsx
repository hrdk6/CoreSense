import React, { useEffect, useState } from 'react';
import {
  Archive,
  Cpu,
  Gamepad2,
  Laptop,
  Monitor,
  Plus,
  Printer,
  Router,
  Smartphone,
  Tablet,
  Trash2,
  X,
} from 'lucide-react';
import { apiRequest } from '../api';

export interface DeviceRecord {
  id: string;
  name: string;
  category: string;
  manufacturer: string;
  model: string;
  osName?: string;
  osVersion?: string;
  notes: string;
  purchaseDate?: string;
  purchasePrice?: number;
  currency: string;
  archived: boolean;
  caseCount: number;
  snapshotCount: number;
  totalRepairSpend: number;
  updatedAt: string;
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  laptop: <Laptop className="h-4 w-4 text-[var(--cs-accent)]" />,
  desktop: <Monitor className="h-4 w-4 text-[var(--cs-accent)]" />,
  smartphone: <Smartphone className="h-4 w-4 text-[var(--cs-ok)]" />,
  tablet: <Tablet className="h-4 w-4 text-[var(--cs-ok)]" />,
  monitor: <Monitor className="h-4 w-4 text-[var(--cs-ink-2)]" />,
  printer: <Printer className="h-4 w-4 text-[var(--cs-warn)]" />,
  gaming_console: <Gamepad2 className="h-4 w-4 text-[var(--cs-ink-2)]" />,
  router: <Router className="h-4 w-4 text-[var(--cs-accent)]" />,
  motherboard: <Cpu className="h-4 w-4 text-[var(--cs-warn)]" />,
};

function formatCategory(cat: string): string {
  const spaced = cat.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const DevicesView: React.FC<{
  devices: DeviceRecord[];
  onRefresh: () => Promise<void>;
}> = ({ devices, onRefresh }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('laptop');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [osName, setOsName] = useState('');
  const [osVersion, setOsVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setModalOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/api/v1/devices', {
        method: 'POST',
        body: {
          name,
          category,
          manufacturer,
          model,
          osName: osName || undefined,
          osVersion: osVersion || undefined,
          notes,
          purchasePrice: purchasePrice ? Number(purchasePrice) : undefined,
        },
      });
      setModalOpen(false);
      setName('');
      setManufacturer('');
      setModel('');
      setOsName('');
      setOsVersion('');
      setNotes('');
      setPurchasePrice('');
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save device.');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (dev: DeviceRecord) => {
    await apiRequest(`/api/v1/devices/${dev.id}`, {
      method: 'PATCH',
      body: { archived: !dev.archived },
    });
    await onRefresh();
  };

  const handleDelete = async (id: string) => {
    await apiRequest(`/api/v1/devices/${id}`, { method: 'DELETE' });
    await onRefresh();
  };

  const totalScans = devices.reduce((s, d) => s + Number(d.snapshotCount || 0), 0);
  const totalCases = devices.reduce((s, d) => s + Number(d.caseCount || 0), 0);
  const totalSpend = devices.reduce((s, d) => s + Number(d.totalRepairSpend || 0), 0);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-[var(--cs-border)]">
        <div className="space-y-1">
          <h1 className="cs-heading text-2xl font-bold text-[var(--cs-ink)]">Personal device library</h1>
          <p className="text-xs text-[var(--cs-ink-muted)]">
            Track hardware specs, linked diagnostics, service manuals, and repair costs per device.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="cs-btn-primary flex items-center gap-1.5 px-4 py-2 text-xs cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>Add device</span>
        </button>
      </div>

      {/* Inventory Summary Strip (Architectural divided baseline) */}
      {devices.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 border border-[var(--cs-border)] rounded-lg bg-[var(--cs-surface)] divide-y sm:divide-y-0 sm:divide-x divide-[var(--cs-border)]">
          <div className="px-4 py-3">
            <div className="text-xs text-[var(--cs-ink-muted)]">Tracked devices</div>
            <div className="font-mono text-xl font-bold text-[var(--cs-ink)] cs-tabular mt-0.5">
              {devices.length}
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs text-[var(--cs-ink-muted)]">Linked scans</div>
            <div className="font-mono text-xl font-bold text-[var(--cs-accent)] cs-tabular mt-0.5">
              {totalScans}
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs text-[var(--cs-ink-muted)]">Repair cases</div>
            <div className="font-mono text-xl font-bold text-[var(--cs-ink)] cs-tabular mt-0.5">
              {totalCases}
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs text-[var(--cs-ink-muted)]">Logged repair spend</div>
            <div className="font-mono text-xl font-bold text-[var(--cs-ok)] cs-tabular mt-0.5">
              ${totalSpend.toFixed(0)}
            </div>
          </div>
        </div>
      )}

      {/* Device Inventory Grid */}
      {devices.length === 0 ? (
        <div className="cs-panel p-12 text-center space-y-3">
          <Laptop className="h-9 w-9 text-[var(--cs-accent)] mx-auto" />
          <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)]">No devices registered</h2>
          <p className="text-xs text-[var(--cs-ink-muted)] max-w-md mx-auto leading-relaxed">
            Add your laptops, phones, routers, consoles, or boards so CoreSense keeps diagnostic
            snapshots and repair history organized across desktop and mobile.
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="cs-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add your first device</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {devices.map((dev) => (
            <div
              key={dev.id}
              className={`cs-panel p-4 flex flex-col justify-between gap-4 transition-colors hover:border-[var(--cs-border-strong)] ${
                dev.archived ? 'opacity-65' : ''
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-9 w-9 rounded-lg bg-[var(--cs-chassis)] border border-[var(--cs-border)] flex items-center justify-center shrink-0">
                      {CATEGORY_ICONS[dev.category] || <Cpu className="h-4 w-4 text-[var(--cs-accent)]" />}
                    </div>
                    <div className="min-w-0">
                      <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)] truncate">
                        {dev.name}
                      </h3>
                      <p className="text-xs text-[var(--cs-ink-muted)] truncate">
                        {[dev.manufacturer, dev.model].filter(Boolean).join(' ') || formatCategory(dev.category)}
                      </p>
                    </div>
                  </div>
                  <span className="shrink-0 text-[11px] font-medium rounded bg-[var(--cs-well)] px-2 py-0.5 text-[var(--cs-ink-2)]">
                    {dev.archived ? 'Archived' : formatCategory(dev.category)}
                  </span>
                </div>

                {(dev.osName || dev.osVersion) && (
                  <div className="text-xs text-[var(--cs-ink-2)] font-mono bg-[var(--cs-canvas)] border border-[var(--cs-border)] rounded-md px-2.5 py-1.5">
                    OS: {[dev.osName, dev.osVersion].filter(Boolean).join(' ')}
                  </div>
                )}

                {dev.notes && (
                  <p className="text-xs text-[var(--cs-ink-muted)] leading-relaxed line-clamp-2">{dev.notes}</p>
                )}

                <div className="grid grid-cols-3 border border-[var(--cs-border)] rounded-md divide-x divide-[var(--cs-border)] bg-[var(--cs-canvas)] text-center">
                  <div className="py-2 px-1">
                    <div className="font-mono text-sm font-bold text-[var(--cs-ink)] cs-tabular">
                      {dev.snapshotCount}
                    </div>
                    <div className="text-[11px] text-[var(--cs-ink-muted)]">Scans</div>
                  </div>
                  <div className="py-2 px-1">
                    <div className="font-mono text-sm font-bold text-[var(--cs-ink)] cs-tabular">
                      {dev.caseCount}
                    </div>
                    <div className="text-[11px] text-[var(--cs-ink-muted)]">Cases</div>
                  </div>
                  <div className="py-2 px-1">
                    <div className="font-mono text-sm font-bold text-[var(--cs-ok-ink)] cs-tabular">
                      ${Number(dev.totalRepairSpend || 0).toFixed(0)}
                    </div>
                    <div className="text-[11px] text-[var(--cs-ink-muted)]">Spend</div>
                  </div>
                </div>
              </div>

              <div className="pt-2.5 border-t border-[var(--cs-border)] flex items-center justify-between text-[11px] text-[var(--cs-ink-muted)]">
                <span className="font-mono cs-tabular">Updated {new Date(dev.updatedAt).toLocaleDateString()}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleArchive(dev)}
                    title={dev.archived ? 'Restore device' : 'Archive device'}
                    aria-label={dev.archived ? 'Restore device' : 'Archive device'}
                    className="p-1.5 rounded-md hover:bg-[var(--cs-well)] text-[var(--cs-ink-muted)] hover:text-[var(--cs-warn)] transition-colors cursor-pointer"
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(dev.id)}
                    title="Delete device"
                    aria-label="Delete device"
                    className="p-1.5 rounded-md hover:bg-[var(--cs-danger-soft)] text-[var(--cs-ink-muted)] hover:text-[var(--cs-danger)] transition-colors cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Device Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 cs-animate-backdrop"
          style={{ backgroundColor: 'var(--cs-scrim)' }}
        >
          <form onSubmit={handleCreate} className="cs-panel max-w-lg w-full p-6 space-y-4 cs-animate-modal">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--cs-border)]">
              <h3 className="cs-heading text-base font-bold text-[var(--cs-ink)]">
                Add personal device
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">
                  Device nickname *
                </label>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. ThinkPad X1 Carbon Gen 11"
                  className="cs-input w-full px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="cs-input w-full px-3 py-2 text-xs"
                >
                  <option value="laptop">Laptop</option>
                  <option value="desktop">Desktop PC</option>
                  <option value="smartphone">Smartphone</option>
                  <option value="tablet">Tablet</option>
                  <option value="monitor">Monitor</option>
                  <option value="printer">Printer</option>
                  <option value="gaming_console">Gaming console</option>
                  <option value="router">Router / network</option>
                  <option value="motherboard">Motherboard / PCB</option>
                  <option value="other">Other electronics</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">Manufacturer</label>
                <input
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  placeholder="Lenovo / Apple / Dell"
                  className="cs-input w-full px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">Model</label>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="21HM000AUS"
                  className="cs-input w-full px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">OS name</label>
                <input
                  value={osName}
                  onChange={(e) => setOsName(e.target.value)}
                  placeholder="Windows 11 / iOS / Android"
                  className="cs-input w-full px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">OS version</label>
                <input
                  value={osVersion}
                  onChange={(e) => setOsVersion(e.target.value)}
                  placeholder="24H2 / 18.2"
                  className="cs-input w-full px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">
                  Purchase price (USD)
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                  placeholder="1299"
                  className="cs-input w-full px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">
                  Notes and service history
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Previous battery replacement, SSD upgraded to 1TB NVMe..."
                  className="cs-input w-full px-3 py-2 text-xs"
                />
              </div>
            </div>
            {error && (
              <div className="rounded-md bg-[var(--cs-danger-soft)] border border-[var(--cs-danger-border)] px-3 py-2 text-xs text-[var(--cs-danger-ink)]">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="cs-btn-secondary px-4 py-2 text-xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="cs-btn-primary px-4 py-2 text-xs cursor-pointer disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save device'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
