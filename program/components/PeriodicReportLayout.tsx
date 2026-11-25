import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { RecordSidebar, RecordSidebarItem } from "./RecordSidebar";
import { SplitWorkspace } from "./SplitWorkspace";
import "./periodic-reports.css";

type SavedReport = {
  id: string;
  title: string;
  report_type: string;
  period_start: string;
  period_end: string;
  status?: "draft" | "final";
};

const periodNames: Record<string, string> = { weekly: "周报", monthly: "月报", custom: "自定义" };

function isoDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function PeriodicReportLayout({ reports, selectedId, onSelect, tools, canGenerate, busy, onGenerate, enterprise, children }: {
  reports: SavedReport[];
  selectedId?: string;
  onSelect: (id: string) => void;
  tools?: ReactNode;
  canGenerate: boolean;
  busy: boolean;
  onGenerate: (event: FormEvent<HTMLFormElement>) => void;
  enterprise?: boolean;
  children: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [reportType, setReportType] = useState("weekly");
  const [start, setStart] = useState(() => isoDate(-6));
  const [end, setEnd] = useState(() => isoDate());
  const showForm = canGenerate && (creating || !reports.length);
  const formId = useId();
  const newButton = useRef<HTMLButtonElement>(null);
  const periodSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (creating) periodSelect.current?.focus();
  }, [creating]);
  function changePeriod(value: string) {
    setReportType(value);
    if (value === "custom") return;
    setStart(isoDate(value === "monthly" ? -29 : -6));
    setEnd(isoDate());
  }
  return <SplitWorkspace className="record-sidebar-layout periodic-report-layout">
    <RecordSidebar title="报告列表" count={reports.length} tools={tools}
      action={canGenerate && reports.length > 0 && <button type="button" ref={newButton}
        aria-expanded={showForm} aria-controls={formId} disabled={busy} onClick={() => setCreating(!creating)}>
        <Plus size={14} aria-hidden="true" />新建报告
      </button>}>
      {reports.map(report => <RecordSidebarItem key={report.id} title={report.title}
        status={report.status ? (report.status === "final" ? "已定稿" : "草稿") : periodNames[report.report_type]}
        meta={`${report.period_start} 至 ${report.period_end}`} selected={!showForm && selectedId === report.id}
        disabled={busy} onSelect={() => { setCreating(false); onSelect(report.id); }} />)}
      {!reports.length && <p>暂无已保存报告</p>}
    </RecordSidebar>
    <div key={showForm ? "new-report" : selectedId} id={formId} className="periodic-report-content">
      {showForm ? <section className="panel periodic-report-create">
        <h2>{enterprise ? "生成企业运营报告" : "生成员工工作报告"}</h2>
        <form onSubmit={onGenerate}>
          <label>报告类型<select ref={periodSelect} name="reportType" value={reportType} onChange={e => changePeriod(e.target.value)} disabled={busy}>
            <option value="weekly">周报</option><option value="monthly">月报</option><option value="custom">自定义</option>
          </select></label>
          <div className="periodic-report-dates">
            <label>开始日期<input type="date" name="periodStart" value={start} max={end || undefined} onChange={e => setStart(e.target.value)} required disabled={busy} /></label>
            <label>结束日期<input type="date" name="periodEnd" value={end} min={start || undefined} onChange={e => setEnd(e.target.value)} required disabled={busy} /></label>
          </div>
          <label>报告标题（选填）<input name="title" maxLength={200} placeholder="默认按报告周期命名" disabled={busy} /></label>
          <div className="periodic-report-submit">
            <button className="primary-button" disabled={busy}>{busy ? "正在生成…" : enterprise ? "生成 / 刷新草稿" : "生成 / 刷新报告"}</button>
            {reports.length > 0 && <button type="button" className="periodic-report-cancel" disabled={busy} onClick={() => {
              setCreating(false);
              newButton.current?.focus();
            }}>取消</button>}
          </div>
        </form>
      </section> : children}
    </div>
  </SplitWorkspace>;
}
