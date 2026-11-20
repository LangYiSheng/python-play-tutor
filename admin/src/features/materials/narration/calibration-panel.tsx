import type { CalibrationReport } from "./api";

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
  return (
    <section className="surface space-y-2 p-4 text-sm">
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
      {Object.keys(report.tag_map ?? {}).length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">
            标签合并（{Object.keys(report.tag_map ?? {}).length} 组）
          </summary>
          {report.tag_stats && (
            <p className="hint">
              标签 {report.tag_stats.before} → {report.tag_stats.after}，合并 {report.tag_stats.merged} 组
            </p>
          )}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b">
                  <th className="py-1 pr-2">别名</th>
                  <th className="py-1">标准名</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(report.tag_map ?? {}).map(([alias, canonical]) => (
                  <tr key={alias} className="border-b">
                    <td className="py-1 pr-2">{alias}</td>
                    <td className="py-1">{canonical}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {report.issues_truncated && (
        <p className="hint" role="note">问题过多，只保留前 120 条。</p>
      )}
      {(report.issues ?? []).length === 0 ? (
        <p className="hint">没有发现问题。</p>
      ) : (
        <ul className="space-y-1">
          {(report.issues ?? []).map((issue) => (
            <li
              key={`${issue.page_no}-${issue.kind}`}
              className="flex items-start gap-2"
            >
              <button
                type="button"
                className="underline"
                onClick={() => setPageNo(issue.page_no)}
              >
                第 {issue.page_no} 页
              </button>
              <span className="hint">
                {issue.kind === "ocr"
                  ? "原文可疑"
                  : issue.kind === "order"
                    ? "页内顺序"
                    : issue.kind === "tag"
                      ? "标签"
                      : "连贯性"}{" "}
                ·{" "}
                {issue.status === "accepted"
                  ? "已接受，需老师确认"
                  : "草稿页，可自动重生成"}
              </span>
              <span>{issue.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
