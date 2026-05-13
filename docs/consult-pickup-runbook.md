# Consult inbox pickup runbook

`scripts/pickup-from-execute.ts` の使い方。実行担当の `pickup-to-execute.ts`
と対称な、相談担当 (相談セッション) 側のヘルパー CLI。

## 役割分担

| 経路 | inbox | 出力 (claim 後) | CLI |
|---|---|---|---|
| 相談 → 実行 (assignment) | `handoff/to-execute/` | `handoff/to-execute/processed/` | `bun scripts/pickup-to-execute.ts ...` |
| 実行 → 相談 (result / propose / ask / progress) | `handoff/from-execute/` | `handoff/processed/from-execute/` | `bun scripts/pickup-from-execute.ts ...` |
| 実行 → relay (done) | `handoff/from-execute/` | `handoff/from-execute/processed/` | watcher (`scripts/inbound-watcher.ts`) が自動で relay |

`type: done` ファイルは watcher の executor-relay が relay 担当。
`pickup-from-execute` は **`type: done` を意図的に読まない** ので、両者を併走
させても race にならない (= 別 type を別経路で消費)。

## 基本コマンド

実行担当の CLI と挙動は同じ:

```bash
# 一覧
bun scripts/pickup-from-execute.ts list

# 中身を読む (= claim しない)
bun scripts/pickup-from-execute.ts show <id-or-filename>

# 1 件 atomically 取って消費する (= rename で取られた人勝ち)
bun scripts/pickup-from-execute.ts claim <id-or-filename>

# 来るまで待つ (= 1 件来たら claim + 印字 + exit)
bun scripts/pickup-from-execute.ts wait --poll-ms 5000

# usage
bun scripts/pickup-from-execute.ts help
```

`<id-or-filename>` は以下のいずれか:

1. 完全なファイル名 (例: `2026-05-13T0250-codex-consult-foo.md`)
2. ファイル名から `.md` を外したもの
3. 完全な `correlation_id`
4. 上記のユニークな部分文字列

複数マッチした場合は候補を出して exit する (= 推測しない)。

## 「来たら拾う」常駐ループ

実行担当の `bun scripts/pickup-to-execute.ts wait --poll-ms 5000` と同じ
シンプル loop。1 件 claim して終わるので、shell で while を回すか、
session 側で次の wait を投げ直す:

```bash
while true; do
  bun scripts/pickup-from-execute.ts wait --poll-ms 5000 || break
  # claim 結果が stdout に出る。相談 session が中身を読んで反応する。
done
```

## 拾ったら何を書くか

`claim` の出力には次の hint が付く:

```
# next: read the body, decide the consult response.
#       - reply to executor → write under handoff/to-execute/ (type: assign)
#       - escalate to Hikaru → write under handoff/pending-human/ (requires_human: true)
#       - dialog continuation → write under handoff/from-consult/
#       Reference the entry above via in_reply_to: <correlation_id>.
```

ファイル名・スキーマは
`templates/handoff-message-template.md`
(`hikaru-agent-knowledge` 側) と `handoff/README.md` 参照。

## Abort flag (= 全エージェント halt 信号)

`handoff/abort-lv2` が存在すると、`pickup-from-execute` は **どのサブ
コマンドも 2 を返して即 exit する** (= 実行担当 CLI と同じ挙動、abort flag
は共有)。Slack DM の `[abort]` で flag が作られる、 `[abort cleanup]` で消える。

実行担当を止めるべき状況 (= 障害・誤操作・実機停止) は通常、相談担当も
止めるべき。**この共有を意図的に維持している** (= 片方だけ止めるなら別の
gating を後付けする)。

## 失敗・崩れたファイルの扱い

- フロントマターが欠ける `.md` → `malformed` カウンタにのみ計上、claim 対象に
  しない。stderr に件数だけ出る (= operator が直接見に行く前提)
- `type` が `result | propose | ask | progress` 以外 → `non-target` カウンタ。
  `type: done` を意図的に外しているのもここに入る (= watcher 担当)
- 2 つ目の consult session が同じ entry を claim しようとした場合、
  `renameSync` が失敗 → CLI は `exit 3` で `claim failed (likely already
  claimed by another consult session)` を出す

## 関連

- 実行担当ガイド: `docs/executor-pickup-runbook.md`
- inter-session-protocol: `task-queue/tasks/2026-05-09-inter-session-protocol.md` (hikaru-agent-knowledge 側)
- handoff dir 配置: `handoff/README.md` (hikaru-agent-knowledge 側)
- ライブラリ: `scripts/lib/from-execute-pickup.ts` (= 共通ヘルパーは
  `scripts/lib/to-execute-pickup.ts` から re-export、executor 側を一切
  改変しない)
