import type { CalibrationIssue, CalibrationReport } from "./api";

function kindLabel(kind: string): string {
  return kind === "ocr"
    ? "原文可疑"
    : kind === "order"
      ? "页内顺序"
      : kind === "tag"
        ? "标签"
        : "连贯性";
}

export function CalibrationPanel({
  report,
  setPageNo,
}: {
  report: CalibrationReport | null;
  setPageNo: (page: number) => void;
}) {
  if (!report) {
    return (
      <section className="surface p-4 text-sm">
        <p className="hint">还没有校准报告。点「一键梳理文本」会整理原文、校准并生成讲解稿。</p>
      </section>
    );
  }
  const usage = report.usage;
  const cachedTokens =
    (usage?.cache_hit_tokens ?? 0) + (usage?.cache_miss_tokens ?? 0);
  const cachePercent = cachedTokens
    ? Math.round(((usage?.cache_hit_tokens ?? 0) / cachedTokens) * 100)
    : null;
  const shrunk = report.shrunk_windows ?? [];
  const renderErrors = report.render_errors ?? [];
  // 同一标准名下的别名合成一行；标准名映射到自身的不算合并。
  const tagGroups = Object.entries(report.tag_map ?? {}).reduce<Record<string, string[]>>(
    (groups, [alias, canonical]) => {
      if (alias !== canonical) (groups[canonical] ??= []).push(alias);
      return groups;
    },
    {},
  );
  const tagRows = Object.entries(tagGroups).sort(([left], [right]) =>
    left.localeCompare(right, "zh"),
  );
  const aliasCount = tagRows.reduce((sum, [, aliases]) => sum + aliases.length, 0);
  const issueGroups = (report.issues ?? []).reduce<Record<number, CalibrationIssue[]>>(
    (groups, issue) => {
      (groups[issue.page_no] ??= []).push(issue);
      return groups;
    },
    {},
  );
  const issueRows = Object.entries(issueGroups)
    .map(([page, items]) => [Number(page), items] as const)
    .sort(([left], [right]) => left - right);
  return (
    <section className="surface space-y-4 p-4 text-sm">
      <p className="font-medium">
        校准报告 · {report.windows} 个窗口 · {report.pages} 页
      </p>
      {report.complete === false && (
        <p className="hint" role="status">
          已跑到 {report.windows_done ?? 0}/{report.windows} 个窗口，后台会自己接着跑完；
          任务中断时再点「一键梳理文本」从断点继续。
        </p>
      )}
      <p className="hint">
        校准修正已自动应用到整理稿（保持草稿，原始文本不动）；审校页正文就是修正后的整理稿。
      </p>
      {report.reused && (
        <p className="hint">整册输入未变，直接复用了上一次的报告。</p>
      )}
      {cachePercent !== null && (
        <p className="hint">
          模型缓存命中 {cachePercent}%（{usage?.cache_hit_tokens ?? 0} / {cachedTokens} tokens）
        </p>
      )}
      <p className="whitespace-pre-wrap">{report.summary || "（无摘要）"}</p>
      {(report.terms ?? []).length > 0 && (
        <p className="hint">术语：{report.terms.join("、")}</p>
      )}
      {shrunk.length > 0 && (
        <p className="hint" role="note">
          第 {shrunk.join("、")} 窗因输入过长按缩减预算完成，覆盖可能不完整。
        </p>
      )}
      {renderErrors.length > 0 && (
        <p className="hint" role="note">
          {renderErrors.length} 页无法渲染页图，已改用文本校对。
        </p>
      )}
      {(report.fixes ?? []).length > 0 && (
        <details open>
          <summary className="cursor-pointer font-medium">
            原文修正（{report.fixes!.length} 处，已自动应用）
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b">
                  <th className="py-1 pr-2">页</th>
                  <th className="py-1 pr-2">修正前</th>
                  <th className="py-1 pr-2">修正后</th>
                  <th className="py-1">原因</th>
                </tr>
              </thead>
              <tbody>
                {report.fixes!.map((fix) => (
                  <tr key={fix.page_no} className="border-b align-top">
                    <td className="py-1 pr-2">
                      <button
                        type="button"
                        className="underline"
                        onClick={() => setPageNo(fix.page_no)}
                      >
                        第 {fix.page_no} 页
                      </button>
                    </td>
                    <td className="max-w-[240px] whitespace-pre-wrap py-1 pr-2">
                      {fix.before}
                    </td>
                    <td className="max-w-[240px] whitespace-pre-wrap py-1 pr-2">
                      {fix.after}
                    </td>
                    <td className="py-1">{fix.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {tagRows.length > 0 && (
        <details className="border-t pt-3">
          <summary className="cursor-pointer font-medium">
            标签合并（{tagRows.length} 个标准名，{aliasCount} 个别名）
          </summary>
          <div className="mt-2 space-y-1">
            {report.tag_stats && (
              <p className="hint">
                标签 {report.tag_stats.before} → {report.tag_stats.after}，合并 {report.tag_stats.merged} 组
              </p>
            )}
            <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b">
                  <th className="py-1 pr-2">标准名</th>
                  <th className="py-1">合并的别名</th>
                </tr>
              </thead>
              <tbody>
                {tagRows.map(([canonical, aliases]) => (
                  <tr key={canonical} className="border-b align-top">
                    <td className="py-1 pr-2 font-medium">{canonical}</td>
                    <td className="py-1">{aliases.join("、")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        </details>
      )}
      {(report.issues ?? []).length === 0 ? (
        <p className="hint">没有发现问题。</p>
      ) : (
        <details open className="border-t pt-3">
          <summary className="cursor-pointer font-medium">
            需核对的问题（{report.issues?.length ?? 0} 条）
          </summary>
          <div className="mt-2 space-y-1">
            <p className="hint">这些是原文或跨页的疑点，校准只记录、未改整理稿。</p>
            {report.issues_truncated && (
              <p className="hint" role="note">问题过多，只保留前 120 条。</p>
            )}
            <ul className="space-y-2">
            {issueRows.map(([pageNo, items]) => (
              <li key={pageNo} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setPageNo(pageNo)}
                  >
                    第 {pageNo} 页
                  </button>
                  <span className="hint">
                    {items.length} 条 · 仅记录，未改整理稿
                  </span>
                </div>
                <ul className="space-y-1 pl-4">
                  {items.map((issue, index) => (
                    <li
                      key={`${issue.kind}-${index}`}
                      className="flex items-start gap-2"
                    >
                      <span className="hint shrink-0">
                        {kindLabel(issue.kind)}
                      </span>
                      <span>{issue.detail}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            </ul>
          </div>
        </details>
      )}
    </section>
  );
}
