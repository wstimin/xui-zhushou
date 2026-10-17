import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Clipboard, Download, Eye, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { adminApi, allPackageOptions, type AdminIdentity, type CdkBatch, type CdkFilters, type CdkRecord, type CdkSelection, type PackageRecord } from './api';
import { CenteredModal, useAdminDialog } from './dialog';
import { usePagedList } from './pagination';

type Notice = { kind: 'success' | 'error'; text: string } | null;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const stateNames = { active: '启用', disabled: '停用', refunded: '已返还' };

export async function copyCdkText(text: string) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* Plain HTTP and denied clipboard permissions need the user-gesture fallback. */ }
  const active = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea'); field.value = text;
  field.style.position = 'fixed'; field.style.opacity = '0'; field.setAttribute('aria-label', '复制 CDK');
  document.body.appendChild(field); field.select();
  try { if (!document.execCommand?.('copy')) throw new Error('浏览器未允许自动复制，请点击查看后手动复制完整 CDK'); }
  finally { field.remove(); active?.focus(); }
}

export function downloadCdkFile(content: string, filename: string, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CdkCodesDialog({ codes, onClose, notify }: { codes: string[]; onClose: () => void; notify: (notice: Notice) => void }) {
  const text = codes.join('\n');
  const copy = async () => {
    try { await copyCdkText(text); notify({ kind: 'success', text: '已复制全部 CDK' }); }
    catch (error) { notify({ kind: 'error', text: errorText(error) }); }
  };
  return <CenteredModal title="CDK 已生成" onClose={onClose}>
    <p className="admin-readonly">已加密保存，可在列表中随时重新查看、复制和导出。</p>
    <textarea aria-label="本次生成的 CDK" readOnly value={text} />
    <div className="admin-dialog-actions"><button className="admin-ghost" onClick={() => void copy()}><Clipboard size={15} />复制全部</button><button className="admin-ghost" onClick={() => downloadCdkFile(text + '\n', 'panelark-cdks.txt')}><Download size={15} />下载 TXT</button><button className="admin-primary" onClick={onClose}>完成</button></div>
  </CenteredModal>;
}

export function CdkManagementTable({ admin, notify, refreshKey }: { admin: AdminIdentity; notify: (notice: Notice) => void; refreshKey: number }) {
  const writable = admin.role !== 'support';
  const dialog = useAdminDialog();
  const [filters, setFilters] = useState<CdkFilters>({});
  const [search, setSearch] = useState('');
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [batches, setBatches] = useState<CdkBatch[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [format, setFormat] = useState<'txt' | 'csv'>('txt');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<CdkRecord | null>(null);
  const fetcher = useCallback((query: { page?: number; pageSize?: number }) => adminApi.cdks({ ...query, ...filters }), [filters]);
  const { items, pagination, load, pager, busy: loading } = usePagedList<CdkRecord, Awaited<ReturnType<typeof adminApi.cdks>>>(fetcher, notify);
  useEffect(() => { setSelected([]); }, [filters]);
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey; void load();
  }, [refreshKey, load]);
  useEffect(() => {
    let active = true;
    void (async () => {
      const options = await allPackageOptions();
      const batchOptions: CdkBatch[] = [];
      for (let page = 1; ; page++) {
        const result = await adminApi.batches({ page, pageSize: 100 }); batchOptions.push(...result.items);
        if (page >= result.pagination.totalPages) break;
      }
      if (active) { setPackages(options); setBatches(batchOptions); }
    })().catch(error => { if (active) notify({ kind: 'error', text: errorText(error) }); });
    return () => { active = false; };
  }, [refreshKey, notify]);

  const reveal = async (item: CdkRecord, copy = false) => {
    setBusy(true);
    try {
      const code = revealed[item.id] || (await adminApi.revealCdk(item.id)).code;
      setRevealed(current => ({ ...current, [item.id]: code }));
      if (copy) { await copyCdkText(code); notify({ kind: 'success', text: 'CDK 已复制' }); }
    } catch (error) { notify({ kind: 'error', text: errorText(error) }); }
    finally { setBusy(false); }
  };
  const exportRows = async (selection: CdkSelection) => {
    setBusy(true);
    try {
      const result = await adminApi.exportCdks({ ...selection, format });
      downloadCdkFile(result.content, result.filename, result.mime);
      notify({ kind: 'success', text: `已导出 ${result.total} 条记录中的 ${result.exported} 个完整 CDK。${result.unavailable ? `其中 ${result.unavailable} 条旧版哈希无法还原明文；CSV 保留这些管理记录，TXT 仅包含完整 CDK。` : ''}` });
    } catch (error) { notify({ kind: 'error', text: errorText(error) }); }
    finally { setBusy(false); }
  };
  const remove = async (ids: string[]) => {
    if (!await dialog.confirm({ title: '删除 CDK', message: `确定永久删除选中的 ${ids.length} 个 CDK？关联授权将一并撤销，已发出的 CDK 将无法继续使用，此操作不可撤销。` })) return;
    setBusy(true);
    try {
      const result = ids.length === 1 ? await adminApi.deleteCdk(ids[0]) : await adminApi.bulkCdks({ ids, action: 'delete' });
      setSelected([]); setRevealed({}); await load(); notify({ kind: 'success', text: `已删除 ${result.affected} 个 CDK` });
    } catch (error) { notify({ kind: 'error', text: errorText(error) }); }
    finally { setBusy(false); }
  };
  const updateStatus = async (status: CdkRecord['status']) => {
    if (!await dialog.confirm({ title: '批量修改 CDK', message: `确定将选中的 ${selected.length} 个 CDK 设置为“${stateNames[status]}”？` })) return;
    setBusy(true);
    try { const result = await adminApi.bulkCdks({ ids: selected, action: 'status', status }); setSelected([]); await load(); notify({ kind: 'success', text: `已更新 ${result.affected} 个 CDK` }); }
    catch (error) { notify({ kind: 'error', text: errorText(error) }); }
    finally { setBusy(false); }
  };
  const allSelected = items.length > 0 && items.every(item => selected.includes(item.id));
  const togglePage = () => setSelected(current => allSelected ? current.filter(id => !items.some(item => item.id === id)) : [...new Set([...current, ...items.map(item => item.id)])]);
  return <section className="admin-panel admin-table-panel cdk-management">
    <div className="cdk-list-heading"><div><h2>CDK 列表</h2><p>共 {pagination.total} 条记录 · 已选 {selected.length} 条</p></div><button className="admin-ghost" disabled={busy || loading} onClick={() => void load()}><RefreshCw size={15} />刷新列表</button></div>
    <form className="cdk-filters" onSubmit={event => { event.preventDefault(); setFilters(current => ({ ...current, search })); }}>
      <label className="admin-field"><span>搜索</span><input placeholder="完整 CDK、末四位、套餐或批次" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label className="admin-field"><span>状态</span><select value={filters.status || ''} onChange={event => setFilters(current => ({ ...current, status: event.target.value }))}><option value="">全部状态</option>{Object.entries(stateNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="admin-field"><span>套餐</span><select value={filters.packageId || ''} onChange={event => setFilters(current => ({ ...current, packageId: event.target.value }))}><option value="">全部套餐</option>{packages.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label className="admin-field"><span>批次</span><select value={filters.batchId || ''} onChange={event => setFilters(current => ({ ...current, batchId: event.target.value }))}><option value="">全部批次</option>{batches.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <button className="admin-primary" disabled={busy}>搜索</button><button type="button" className="admin-ghost" onClick={() => { setSearch(''); setFilters({}); }}>清除筛选</button>
    </form>
    {writable && <div className="cdk-toolbar">
      <label>导出格式<select aria-label="导出格式" value={format} onChange={event => setFormat(event.target.value as 'txt' | 'csv')}><option value="txt">TXT 完整 CDK</option><option value="csv">CSV 管理记录</option></select></label>
      <button className="admin-ghost" disabled={busy || !pagination.total} onClick={() => void exportRows({ scope: 'filtered', filters })}><Download size={15} />导出全部筛选结果</button>
      <button className="admin-ghost" disabled={busy || !selected.length} onClick={() => void exportRows({ ids: selected })}>导出选中</button>
      <span className="cdk-toolbar-divider" />
      <button className="admin-ghost" disabled={busy || !selected.length} onClick={() => void updateStatus('active')}>批量启用</button><button className="admin-ghost" disabled={busy || !selected.length} onClick={() => void updateStatus('disabled')}>批量停用</button><button className="admin-ghost cdk-danger" disabled={busy || !selected.length} onClick={() => void remove(selected)}><Trash2 size={15} />批量删除</button>
    </div>}
    <div className="admin-table-wrap"><table><thead><tr>{writable && <th><input type="checkbox" aria-label="选择当前页全部 CDK" checked={allSelected} onChange={togglePage} /></th>}<th>CDK / 批次</th><th>套餐</th><th>使用</th><th>状态</th><th>有效期</th><th>管理操作</th></tr></thead><tbody>{items.map(item => <tr key={item.id}>
      {writable && <td><input type="checkbox" aria-label={`选择 CDK ${item.code_hint}`} checked={selected.includes(item.id)} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /></td>}
      <td><code className="cdk-code">{revealed[item.id] || item.code_hint}</code><small className="cdk-row-note">{item.batch_name || '无批次'}{!item.code_available && ' · 旧版哈希记录'}</small></td><td>{item.package_name}</td><td>{item.used_count}/{item.max_uses}{item.locked_count > 0 && <small> · 占用 {item.locked_count}</small>}</td><td><span className={`admin-status ${item.status}`}>{stateNames[item.status]}</span></td><td>{item.expires_at ? new Date(item.expires_at).toLocaleString('zh-CN', { hour12: false }) : '永久有效'}</td>
      <td>{writable ? <div className="cdk-row-actions"><button className="admin-ghost" disabled={busy || !item.code_available} onClick={() => revealed[item.id] ? setRevealed(current => { const next = { ...current }; delete next[item.id]; return next; }) : void reveal(item)}><Eye size={14} />{revealed[item.id] ? '隐藏' : '查看'}</button><button className="admin-ghost" disabled={busy || !item.code_available} onClick={() => void reveal(item, true)}><Clipboard size={14} />复制</button><button className="admin-ghost" disabled={busy} onClick={() => setEditing(item)}><Pencil size={14} />编辑</button><button className="admin-ghost cdk-danger" disabled={busy} onClick={() => void remove([item.id])}><Trash2 size={14} />删除</button></div> : '只读'}</td>
    </tr>)}</tbody></table>{!items.length && <div className="admin-empty">没有匹配的 CDK</div>}</div>{pager}
    {editing && <CdkEditDialog item={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); setRevealed({}); await load(); }} notify={notify} />}
  </section>;
}

function CdkEditDialog({ item, onClose, onSaved, notify }: { item: CdkRecord; onClose: () => void; onSaved: () => Promise<void>; notify: (notice: Notice) => void }) {
  const localTime = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const [form, setForm] = useState({ status: item.status, maxUses: String(item.max_uses), usedCount: String(item.used_count), expiresAt: localTime(item.expires_at), originalCode: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await adminApi.updateCdk(item.id, { ...form, maxUses: Number(form.maxUses), usedCount: Number(form.usedCount), expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null }); await onSaved(); notify({ kind: 'success', text: 'CDK 已更新' }); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  return <CenteredModal title="编辑 CDK" onClose={() => { if (!busy) onClose(); }}><form noValidate onSubmit={submit} className="cdk-edit-form">
    <p className="admin-readonly">{item.code_hint} · {item.package_name}。此处调整只影响这一个 CDK，不修改套餐和其他 CDK。</p>
    <div className="admin-form-grid"><label className="admin-field"><span>状态</span><select value={form.status} onChange={event => setForm({ ...form, status: event.target.value as CdkRecord['status'] })}>{Object.entries(stateNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="admin-field"><span>总使用次数</span><input type="number" min="1" max="10000" value={form.maxUses} onChange={event => setForm({ ...form, maxUses: event.target.value })} /></label><label className="admin-field"><span>已使用次数</span><input type="number" min="0" value={form.usedCount} onChange={event => setForm({ ...form, usedCount: event.target.value })} /></label><label className="admin-field"><span>有效期（留空永久有效）</span><input type="datetime-local" value={form.expiresAt} onChange={event => setForm({ ...form, expiresAt: event.target.value })} /></label></div>
    {!item.code_available && <label className="admin-field"><span>绑定原始 CDK（可选）</span><input autoComplete="off" value={form.originalCode} onChange={event => setForm({ ...form, originalCode: event.target.value })} placeholder="粘贴你保存的此条完整 CDK" /><small>旧版只保存哈希，无法凭空还原。原码匹配后加密保存，以后即可查看和导出；不会更换授权码。</small></label>}
    {error && <p className="admin-warning" role="alert">{error}</p>}
    <div className="admin-dialog-actions"><button type="button" className="admin-ghost" disabled={busy} onClick={onClose}>取消</button><button className="admin-primary" disabled={busy}>{busy ? '正在保存…' : '保存修改'}</button></div>
  </form></CenteredModal>;
}
