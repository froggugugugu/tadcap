export const meta = {
  name: 'skill-eval',
  description: 'skill の evals/evals.json を skill あり / なしの 2 系統で実行し、assertions を独立した採点者が判定して pass rate を比較する',
  whenToUse: 'skill の description や本文を変えたあと、発動と出力品質が劣化していないかを数値で確認するとき',
  phases: [
    { title: 'Cases', detail: 'evals/evals.json を読み、対象ケースを確定する' },
    { title: 'Run', detail: '各ケースを skill あり / なしの 2 系統で実行する' },
    { title: 'Grade', detail: 'assertions を独立した採点者が PASS / FAIL で判定する' },
    { title: 'Report', detail: 'pass rate と差分を testreport/evals/ に書く' },
  ],
}

// ────────────────────────────────────────────────────────────────────────────
// skill-eval — eval-first を回すための saved workflow(team 層)
//
// 使い方:  /skill-eval skill=prd
//          /skill-eval skill=prd iteration=2 cases=1
// args:    { skill: string, iteration?: number, cases?: number[] | string }
//
// 設計:
//   - 同じ prompt を skill あり / なしで実行し、差分で skill の寄与を測る(公式の with / without 方式)
//   - 採点は実行していない別の agent が行う(自己評価バイアス対策)
//   - 成果物は testreport/evals/<skill>/iteration-<N>/ に隔離して書く(gitignore 済み)
//   - assertions の判定は確証が無ければ FAIL 側に倒す
// コスト目安: 1 + ケース数 × 3 + 1 agent。ケースが多いときは cases= で絞る
// ────────────────────────────────────────────────────────────────────────────

const SKILL = args && (args.skill || args.name)
const ITER = (args && Number(args.iteration)) || 1
const ONLY = args && args.cases
  ? (Array.isArray(args.cases) ? args.cases : String(args.cases).split(',')).map((x) => Number(x))
  : null

const CASES_SCHEMA = {
  type: 'object',
  required: ['skill_name', 'cases'],
  properties: {
    skill_name: { type: 'string' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'prompt', 'assertions'],
        properties: {
          id: { type: 'integer' },
          prompt: { type: 'string' },
          expected_output: { type: 'string' },
          assertions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const ARM_SCHEMA = {
  type: 'object',
  required: ['files', 'summary'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    used_skill: { type: 'boolean' },
  },
}

const GRADE_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['assertion', 'with_pass', 'without_pass', 'evidence'],
        properties: {
          assertion: { type: 'string' },
          with_pass: { type: 'boolean' },
          without_pass: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  required: ['path', 'verdict'],
  properties: {
    path: { type: 'string' },
    verdict: { type: 'string', enum: ['skill が有効', '差が小さい', 'skill が悪化させている'] },
  },
}

if (!SKILL) {
  log('skill 名が必要です。例: /skill-eval skill=prd')
  return { error: 'skill が指定されていません' }
}
const WS = `testreport/evals/${SKILL}/iteration-${ITER}`

phase('Cases')
const suite = await agent(
  `.claude/skills/${SKILL}/evals/evals.json を読み、skill_name と cases(id / prompt / expected_output / assertions)を返す。ファイルが無ければ cases を空配列で返す。ファイルは変更しない。`,
  { label: `cases:${SKILL}`, phase: 'Cases', schema: CASES_SCHEMA, effort: 'low' },
)
if (!suite || suite.cases.length === 0) {
  log(`.claude/skills/${SKILL}/evals/evals.json が見つからないか、ケースが空です`)
  return { skill: SKILL, cases: 0 }
}
const cases = ONLY ? suite.cases.filter((c) => ONLY.includes(c.id)) : suite.cases
log(`${cases.length} ケースを実行する(1 ケースあたり 3 agent、出力先 ${WS}/)`)

const WRITE_RULE = (arm) =>
  `成果物は ${WS}/${arm}/ の下に、本来の出力先パスを再現して書く(例: output/prd/PRD_auth.md なら ${WS}/${arm}/output/prd/PRD_auth.md)。` +
  `この配下以外のファイルは読んでよいが変更しない。最後に、作成したファイルのパス一覧と回答の要点を返す。`

phase('Run')
const graded = await pipeline(
  cases,
  (c) =>
    parallel([
      () =>
        agent(
          `このプロジェクトのセッションとして次の依頼に応える。必要だと判断した skill は自由に使ってよい。\n依頼: ${c.prompt}\n\n${WRITE_RULE('with')}\nskill を使ったかどうかを used_skill に入れる。`,
          { label: `with:${c.id}`, phase: 'Run', schema: ARM_SCHEMA },
        ),
      () =>
        agent(
          `次の依頼に応える。ただし skill は一切使わない(Skill ツールを呼ばない)。既定の知識だけで対応する。\n依頼: ${c.prompt}\n\n${WRITE_RULE('without')}\nused_skill は false にする。`,
          { label: `without:${c.id}`, phase: 'Run', schema: ARM_SCHEMA },
        ),
    ]),
  (arms, c) => {
    const [w, wo] = arms
    if (!w && !wo) return null
    return agent(
      `2 系統の成果物を比べ、assertions を 1 件ずつ判定する。` +
        `${WS}/with/ を with 系統のプロジェクトルート、${WS}/without/ を without 系統のプロジェクトルートとみなし、実際にファイルを読んで確かめる。` +
        `確証が持てない場合は FAIL にする。ファイルは変更しない。\n` +
        `依頼: ${c.prompt}\n期待する結果: ${c.expected_output || '(未記載)'}\n` +
        `assertions:\n${c.assertions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n` +
        `with の報告: ${w ? JSON.stringify(w) : '(実行失敗)'}\n` +
        `without の報告: ${wo ? JSON.stringify(wo) : '(実行失敗)'}`,
      { label: `grade:${c.id}`, phase: 'Grade', schema: GRADE_SCHEMA },
    ).then((g) => (g ? { id: c.id, prompt: c.prompt, used_skill: w ? w.used_skill : null, results: g.results } : null))
  },
)

const rows = graded.filter(Boolean)
const flat = rows.flatMap((r) => r.results)
const pct = (n) => (flat.length ? Math.round((n / flat.length) * 1000) / 10 : 0)
const withRate = pct(flat.filter((r) => r.with_pass).length)
const withoutRate = pct(flat.filter((r) => r.without_pass).length)
const notTriggered = rows.filter((r) => r.used_skill === false).map((r) => r.id)
log(`assertions ${flat.length} 件: with ${withRate}% / without ${withoutRate}% (差 ${Math.round((withRate - withoutRate) * 10) / 10} ポイント)`)
if (notTriggered.length > 0) {
  log(`with 系統で skill が発動しなかったケース: ${notTriggered.join(', ')} — description のトリガー語を見直す`)
}
if (rows.length < cases.length) {
  log(`${cases.length - rows.length} ケースは採点できませんでした(実行または採点が失敗)`)
}

phase('Report')
const report = await agent(
  `次の JSON から eval レポートを作る。${WS}/benchmark.json に JSON をそのまま保存し、${WS}/SUMMARY.md に人間向けの要約を書く。${WS}/ 以外には書き込まない。
SUMMARY.md には次を含める:
- 対象 skill、iteration、ケース数、assertion 数
- with / without の pass rate と差(ポイント)
- ケースごとの assertion 判定(PASS / FAIL と根拠)
- with でも FAIL だった assertion の一覧(skill 改善の入力)
- with と without の両方で PASS した assertion の一覧(skill の寄与が無い項目。次回の eval から差し替える候補)
- skill が発動しなかったケース(あれば description の見直し対象)
作成したファイルのパスと、判定(差が 10 ポイント以上なら「skill が有効」、-5 〜 10 ポイントなら「差が小さい」、-5 ポイント未満なら「skill が悪化させている」)を返す。

${JSON.stringify({ skill: SKILL, iteration: ITER, assertions: flat.length, with_pass_rate: withRate, without_pass_rate: withoutRate, not_triggered: notTriggered, cases: rows })}`,
  { label: 'report', phase: 'Report', schema: REPORT_SCHEMA },
)

return {
  skill: SKILL,
  iteration: ITER,
  cases: rows.length,
  assertions: flat.length,
  with_pass_rate: withRate,
  without_pass_rate: withoutRate,
  verdict: report ? report.verdict : null,
  report: report ? report.path : null,
}
