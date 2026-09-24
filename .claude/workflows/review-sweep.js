export const meta = {
  name: 'review-sweep',
  description: '変更差分を 4 観点で並列レビューし、MUST 指摘を 3 票の反証で検証してから 1 本のレポートにまとめる',
  whenToUse: 'PR 作成前、実装ゲート・検証ゲートの前、大きな差分を自己評価バイアスなしで多観点レビューしたいとき',
  phases: [
    { title: 'Scope', detail: 'レビュー対象の差分とファイル一覧を確定する' },
    { title: 'Review', detail: '仕様・品質 / セキュリティ / パフォーマンス / テストの 4 観点で並列レビュー' },
    { title: 'Verify', detail: 'MUST 指摘ごとに 3 体の懐疑役が反証を試みる' },
    { title: 'Report', detail: '生き残った指摘を output/reports/review/ にまとめる' },
  ],
}

// ────────────────────────────────────────────────────────────────────────────
// review-sweep — TEAM_QA のレビュー工程を自動化した saved workflow(team 層)
//
// 使い方:  /review-sweep                       … origin/main との差分をレビュー
//          /review-sweep base=develop maxVerify=10
// args:    { base?: string, maxVerify?: number }
//
// 設計:
//   - 実装した本人の文脈を持たない独立 agent がレビューする(自己評価バイアス対策)
//   - 4 観点の結果は重複排除のためにバリアで集約し、MUST だけを反証検証する
//   - 反証は 3 票中 2 票以上が「実在する」と判断した指摘だけを確定にする
//   - 検証件数の上限を超えた MUST は落とさず「未検証」としてレポートに残す
// コスト目安: 1 + 4 + 3×min(MUST件数, maxVerify) + 1 agent
// ────────────────────────────────────────────────────────────────────────────

const BASE = (args && args.base) || 'origin/main'
const MAX_VERIFY = (args && Number(args.maxVerify)) || 6

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['base', 'files', 'summary'],
  properties: {
    base: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'line', 'title', 'evidence', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['MUST', 'SHOULD', 'CONSIDER'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  required: ['path', 'verdict'],
  properties: {
    path: { type: 'string' },
    verdict: { type: 'string', enum: ['承認', '条件付き承認（MUST修正後）', '要修正'] },
  },
}

const READ_ONLY = 'ファイルは一切変更しない。根拠はファイルパスと行番号で示し、推測で指摘しない。'

phase('Scope')
const scope = await agent(
  `git diff ${BASE}...HEAD と git status で、レビュー対象の変更ファイル一覧(削除ファイルを除く)と変更の要約を返す。${READ_ONLY}`,
  { label: 'scope', phase: 'Scope', schema: SCOPE_SCHEMA, effort: 'low' },
)

if (!scope || scope.files.length === 0) {
  log(`${BASE} との差分が無いためレビューを終了します`)
  return { report: null, confirmed: 0, refuted: 0, unverified: 0 }
}
log(`対象 ${scope.files.length} ファイル: ${scope.summary}`)

const FILES = scope.files.join('\n')
const DIMENSIONS = [
  {
    key: 'spec-quality',
    prompt: `.claude/skills/code-review/SKILL.md の「レビュー観点」1〜3・8・9 と重要度定義に従い、次のファイルの ${BASE} からの変更を仕様準拠・コード品質・アーキテクチャ・後方互換性・ドキュメント同期の観点でレビューする。\n${FILES}\n${READ_ONLY}`,
  },
  {
    key: 'security',
    agentType: 'security-reviewer',
    prompt: `次のファイルの ${BASE} からの変更を OWASP Top 10 / CWE の観点でレビューする。CRITICAL・HIGH は severity=MUST、MEDIUM は SHOULD、LOW・INFO は CONSIDER として返す。シークレットの値は転記しない。\n${FILES}\n${READ_ONLY}`,
  },
  {
    key: 'performance',
    agentType: 'performance-analyst',
    prompt: `次のファイルの ${BASE} からの変更に、計測なしでも差分から明らかな性能劣化(N+1、無制限ループ、不要な再レンダリング、同期 I/O)が無いかをレビューする。計測コマンドは実行しない。計測が必要な懸念は CONSIDER にする。\n${FILES}\n${READ_ONLY}`,
  },
  {
    key: 'tests',
    prompt: `.claude/skills/code-review/SKILL.md の「レビュー観点」7 に従い、次のファイルの変更に対してテストが振る舞いを検証しているか、境界値・異常系が抜けていないかをレビューする。\n${FILES}\n${READ_ONLY}`,
  },
]

phase('Review')
const reviews = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA, agentType: d.agentType }),
  ),
)
DIMENSIONS.forEach((d, i) => {
  if (!reviews[i]) log(`観点 ${d.key} のレビューが失敗しました(レポートに記載されます)`)
})

// 観点をまたいだ重複を file:line と見出しで排除する(全観点の結果が必要なためバリアを使う)
const seen = new Set()
const findings = []
reviews.forEach((r, i) => {
  if (!r) return
  for (const f of r.findings) {
    const key = `${f.file}:${f.line}:${f.title.toLowerCase().slice(0, 40)}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({ ...f, dimension: DIMENSIONS[i].key })
  }
})

const musts = findings.filter((f) => f.severity === 'MUST')
const toVerify = musts.slice(0, MAX_VERIFY)
const unverified = musts.slice(MAX_VERIFY)
if (unverified.length > 0) {
  log(`MUST ${musts.length} 件のうち ${unverified.length} 件は検証上限(maxVerify=${MAX_VERIFY})を超えたため未検証として残します`)
}

phase('Verify')
const verified = await parallel(
  toVerify.map((f, i) => () =>
    parallel(
      [0, 1, 2].map((v) => () =>
        agent(
          `次の指摘が実在するか、反証を試みる。コードを読み、指摘が誤り・過大評価・既に対処済みなら refuted=true とする。確信が持てない場合も refuted=true にする。\n指摘: [${f.dimension}] ${f.file}:${f.line} ${f.title}\n根拠: ${f.evidence}\n${READ_ONLY}`,
          { label: `verify:${i + 1}-${v + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ),
      ),
    ).then((votes) => {
      const valid = votes.filter(Boolean)
      const upheld = valid.filter((x) => !x.refuted).length
      return { ...f, upheld, votes: valid.length, survives: upheld >= 2 }
    }),
  ),
)

const confirmed = verified.filter((f) => f && f.survives)
const refuted = verified.filter((f) => f && !f.survives)
log(`MUST 検証: 確定 ${confirmed.length} / 反証 ${refuted.length} / 未検証 ${unverified.length}`)

const others = findings.filter((f) => f.severity !== 'MUST')
const failedDimensions = DIMENSIONS.filter((d, i) => !reviews[i]).map((d) => d.key)

phase('Report')
const report = await agent(
  `次の JSON からレビューレポートを作る。ファイル名は \`date +%Y%m%d-%H%M\` を実行して output/reports/review/SWEEP_<日時>.md とし、output/reports/review/ 以外には書き込まない。
形式は .claude/skills/code-review/SKILL.md の「レポートフォーマット」に従い、次を必ず含める:
- 概要: 対象ブランチ差分(${BASE})、ファイル数、失敗した観点
- 指摘事項: MUST(確定のみ)→ SHOULD → CONSIDER。各指摘に観点名・ファイル:行・理由・修正案
- 反証された MUST と未検証の MUST を別セクションに列挙(未検証は人間の確認対象として明示)
- 総合判定: 確定 MUST が 0 件なら「承認」、1 件以上なら「条件付き承認（MUST修正後）」、設計見直しが必要なら「要修正」
作成したファイルのパスと総合判定を返す。

${JSON.stringify({ base: BASE, files: scope.files, failedDimensions, confirmed, refuted, unverified, others })}`,
  { label: 'report', phase: 'Report', schema: REPORT_SCHEMA },
)

return {
  report: report ? report.path : null,
  verdict: report ? report.verdict : null,
  confirmed: confirmed.length,
  refuted: refuted.length,
  unverified: unverified.length,
  others: others.length,
}
