const navGroups = [
  { label: "运营工作", items: [["工作台", "⌂", true], ["选题中心", "◇", false], ["内容生产", "✦", false], ["审核中心", "✓", false, "6"], ["内容日历", "▦", false]] },
  { label: "研究与资产", items: [["视频分析", "▷", false], ["对标内容库", "◫", false], ["品牌知识库", "▤", false], ["素材中心", "□", false]] },
  { label: "增长复盘", items: [["发布管理", "↗", false], ["数据复盘", "⌁", false], ["报告中心", "≡", false]] },
] as const;

const tasks = [
  { title: "确认《老板为什么总在招错人》终稿", meta: "客户审核 · 今天 18:00", type: "审核", tone: "danger" },
  { title: "补充 3 条八月招聘季选题", meta: "选题规划 · 今天", type: "策划", tone: "warning" },
  { title: "上传周三拍摄成片", meta: "素材交付 · 明天 12:00", type: "素材", tone: "neutral" },
];

const reviewItems = [
  { title: "管理者别用苦劳感动自己", stage: "客户审核", owner: "陈思", due: "剩 2 小时" },
  { title: "小团队最容易忽略的用人成本", stage: "内部审核", owner: "林溪", due: "今天" },
  { title: "员工离职前的三个信号", stage: "客户审核", owner: "周可", due: "明天" },
];

export default function Home() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="利明智耀工作台首页"><span className="brand-mark" aria-hidden="true">利</span><span>利明智耀</span></a>
        <button className="project-switcher" type="button" aria-label="切换客户项目"><span className="project-logo">澄</span><span className="project-copy"><small>当前客户项目</small><strong>澄川管理咨询</strong></span><span aria-hidden="true">⌄</span></button>
        <div className="top-actions">
          <button className="search-button" type="button" aria-label="全局搜索"><span aria-hidden="true">⌕</span><span>搜索内容、视频或成员</span><kbd>⌘ K</kbd></button>
          <button className="icon-button notification" type="button" aria-label="通知"><span aria-hidden="true">◌</span><i /></button>
          <button className="avatar" type="button" aria-label="打开个人菜单">LX</button>
        </div>
      </header>

      <aside className="sidebar" aria-label="主导航">
        <nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map(([label, icon, active, count]) => <a className={active ? "nav-item active" : "nav-item"} href={active ? "#main" : `#${label}`} key={label} aria-current={active ? "page" : undefined}><span aria-hidden="true">{icon}</span><strong>{label}</strong>{count && <em>{count}</em>}</a>)}</div>)}</nav>
        <div className="sidebar-footer"><a className="nav-item" href="#成员与权限"><span aria-hidden="true">♙</span><strong>成员与权限</strong></a><a className="nav-item" href="#系统设置"><span aria-hidden="true">⚙</span><strong>系统设置</strong></a></div>
      </aside>

      <main id="main" className="workspace">
        <section className="page-heading"><div><p>2026 年 8 月 5 日，星期三</p><h1>上午好，林溪</h1><span>这里是澄川管理咨询今天最需要推进的工作。</span></div><button className="primary-button" type="button"><span aria-hidden="true">＋</span> 新建内容</button></section>

        <section className="attention-grid" aria-label="今日工作概览">
          <article className="attention-card important"><div className="card-eyebrow"><span className="signal red" />需要优先处理</div><div className="big-number">6</div><p>条内容等待审核</p><div className="card-trend urgent">其中 2 条将在今天逾期</div><a href="#审核中心">进入审核中心 <span aria-hidden="true">→</span></a></article>
          <article className="attention-card"><div className="card-eyebrow"><span className="signal amber" />本周内容进度</div><div className="progress-copy"><strong>8 / 12</strong><span>已完成</span></div><div className="progress-track" aria-label="本周内容完成 67%"><i style={{ width: "67%" }} /></div><div className="card-trend">较计划慢 1 条 · 周五前需补齐</div></article>
          <article className="attention-card"><div className="card-eyebrow"><span className="signal blue" />异常增长</div><div className="big-number">2</div><p>条视频值得复用</p><div className="spark" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div><a href="#数据复盘">查看增长原因 <span aria-hidden="true">→</span></a></article>
          <article className="attention-card compact"><div className="card-eyebrow"><span className="signal green" />对标动态</div><div className="big-number">14</div><p>条新内容已入库</p><div className="card-trend positive">3 条进入高表现候选</div><a href="#对标内容库">查看对标内容 <span aria-hidden="true">→</span></a></article>
        </section>

        <section className="content-grid">
          <div className="main-column">
            <article className="panel task-panel"><div className="panel-heading"><div><p className="section-kicker">今日待办</p><h2>先把关键节点向前推</h2></div><button type="button" className="text-button">查看全部 9 项</button></div><div className="task-list">{tasks.map((task) => <label className="task-row" key={task.title}><input type="checkbox" /><span className="checkmark" aria-hidden="true" /><span className="task-main"><strong>{task.title}</strong><small>{task.meta}</small></span><span className={`status ${task.tone}`}>{task.type}</span><button type="button" aria-label={`打开${task.title}`}><span aria-hidden="true">›</span></button></label>)}</div></article>

            <article id="审核中心" className="panel review-panel"><div className="panel-heading"><div><p className="section-kicker">待审核内容</p><h2>6 条内容等待决定</h2></div><div className="avatar-stack" aria-label="3 位审核参与者"><span>陈</span><span>林</span><span>周</span></div></div><div className="table-wrap"><table><caption className="sr-only">待审核内容列表</caption><thead><tr><th>内容</th><th>当前阶段</th><th>负责人</th><th>截止</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{reviewItems.map((item) => <tr key={item.title}><td><strong>{item.title}</strong><small>短视频 · 口播</small></td><td><span className="status neutral">{item.stage}</span></td><td>{item.owner}</td><td className={item.due.includes("小时") ? "due" : ""}>{item.due}</td><td><button className="row-action" type="button" aria-label={`审核${item.title}`}>审核</button></td></tr>)}</tbody></table></div></article>
          </div>

          <div className="side-column">
            <article className="panel suggestion-panel"><div className="suggestion-icon" aria-hidden="true">✦</div><p className="section-kicker">下一步建议</p><h2>趁热延展“招聘避坑”系列</h2><p>近 14 天的 5 条高收藏视频都以“错误示范”开场。建议补做 3 条同结构选题，优先覆盖试用期与管理者面试。</p><div className="evidence"><span>依据</span><strong>28 条历史内容</strong><strong>7 条对标样本</strong></div><button className="secondary-button" type="button">生成 3 个候选选题</button></article>

            <article id="视频分析" className="panel jobs-panel"><div className="panel-heading"><div><p className="section-kicker">最近分析任务</p><h2>处理进度</h2></div><a href="#视频分析">全部</a></div><div className="job"><span className="job-icon">影</span><div><strong>管理者的三种无效勤奋</strong><small>正在提取字幕与关键帧</small><div className="progress-track small"><i style={{ width: "72%" }} /></div></div><em>72%</em></div><div className="job"><span className="job-icon complete">访</span><div><strong>访谈账号 · 8 月批次</strong><small>18 条视频 · 已完成</small></div><em className="complete-text">完成</em></div><div className="job"><span className="job-icon error">案</span><div><strong>竞品案例拆解 03</strong><small>媒体源失效，可重新上传</small></div><button type="button">重试</button></div></article>
          </div>
        </section>

        <footer className="product-note"><span>首版工作台原型</span><span>数据为演示样例</span><span>最近更新 10:42</span></footer>
      </main>
    </div>
  );
}
