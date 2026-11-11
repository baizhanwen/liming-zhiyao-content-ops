# Structured content contract

`report.content_analysis` is additive to `analysis.v10`; all previous report prose remains.
The taxonomy JSON beside this file is the shared Python/TypeScript source of IDs.
Neither v9 prose nor user asset tags are converted into these classifications.

## Compact unified-production entry

`build_content_analysis_bundle(..., max_workers=1, on_module_checkpoint=None,
resume_modules=None, transcript_basis="canonical")` returns
`{content_analysis, findings_by_module, module_results}`. The legacy
`build_content_analysis` callback and return contract below remain unchanged.
The compact entry uses `content-module-wire.v1`, implemented in
`content_module_protocol.py`; the public lazy SDK schema factory is
`create_compact_response_model(module_key)`.

Wire output is `{c, g, u, f}`: classifications use request-local numeric dimension,
tag and evidence indices; segment and finding kinds use their module tables.
The decoder restores stable IDs and derives segment times from original cited
source envelopes. The model never generates evidence IDs, frame paths, times,
measurement values or a repeated long report. Segments and information units
are bounded separately per module; visual has neither and synthesis has at most
one reusable template. Findings are bounded to at most six per module and each
must reference actual semantic source evidence. Visual findings require vision,
not OCR or a timing-group record alone. Input/output caps are shared under
`taxonomy.budgets.standard/max.compact`.

The stored `content_analysis` shape remains `content-analysis.v1`; its methodology
adds optional `transcript_basis: "canonical" | "original"`. Metrics should be
supplied from original pre-correction ASR measurements, while semantic modules use
the validated canonical transcript. Findings remain outside this stored object:
`findings_by_module[module] = [{section, text, evidence_ids}]`.

Successful module cache entries are
`{signature, status: "completed", validation: {passed: true, issues: []},
response: {classifications, segments, information_units}, findings}`. Signatures
bind the exact compact input, profile and protocol; the caller additionally binds
source/model/prompt/taxonomy in the enclosing checkpoint. Restore revalidates
every classification, source reference and finding; a status flag alone is never
trusted. Failed modules are not checkpointed. Checkpoint acknowledgements run on
the caller thread before submitting additional work. First three modules have at
most two requests in flight; synthesis runs last. Failed or unavailable upstream
modules defer synthesis without a paid request; explicit not-applicable modules
(for example an audio-only file's visual module) do not block it.

## Stored object

```text
schema_version: "content-analysis.v1"
taxonomy_version: "video-taxonomy.v1"
profile: string
status: "complete" | "partial"
evidence_registry: Evidence[]
classifications: Classification[]  # exactly one per taxonomy dimension, taxonomy order
segments: Segment[]
information_units: InformationUnit[]
metrics: object                    # supplied content-metrics.v1; never LLM-generated
methodology: {transcript_source, sampling_strategy_id, sampling_config,
              evidence_version, temporal_min_frames: 3}
module_status: {text_topic_structure_audience, text_expression_value, visual, synthesis}
validation: {passed: boolean, issues: string[]}
```

Each module status is `{status, reason, validation, source_coverage}`. Status is `completed`, `failed`,
`not_acquired`, or `not_applicable`; validation is `{passed, issues}`. Missing or
rejected classifications remain explicit unknown/not-acquired rows, never invented labels.
Validation issues are bounded fixed diagnostic codes, not raw provider errors.

`source_coverage` is null for an unrequested module; otherwise it contains
`{complete, included_evidence_count, available_evidence_count,
required_opening_complete, temporal_groups_available, temporal_groups_included,
input_token_limit, estimated_payload_tokens}`. Required-opening completeness is
boolean or null. This records the actual input observation and does not enter
`methodology.sampling_config` or comparison grouping keys. Normal representative
sampling can produce a complete report, with `representative_evidence_sample`
as its module reason and explicit coverage. Missing required opening evidence,
missing usable sources, provider failures or malformed outputs remain partial.

`Evidence = {id, source, text, start_ms, end_ms, asset_ref, frame_group_id}`.
Source is `transcript`, `ocr`, `vision`, `frame`, or `temporal`. Transcript source
ASR/manual is recorded separately in methodology; neither is audio-character analysis.
Times are integer milliseconds or null. Asset references are storage IDs or null,
never local paths. IDs are deterministic 1-based ordinal IDs (`transcript:0001`,
`frame:0001`, `ocr:0001`, `vision:0001`) and `temporal:<group_id>`.

`Classification = {dimension_id, state, tags, primary_tag, reason, evidence_ids}`.
State is `known`, `unknown`, `not_acquired`, or `not_applicable`. Non-known rows
have `tags: null`, `primary_tag: null`, and a nonempty reason. Known rows have a
tag array; empty means confirmed absence unless the dimension has a dedicated
none tag (then that tag must be used). None cannot coexist with another tag.
Single dimensions allow at most one tag. Required primary is required when tags
are present and must be selected. Known rows, including absence, require valid
evidence. Inference is indicated by taxonomy metadata (e.g. intended emotion),
not falsely presented as an observed audience reaction.

`Segment = {id, kind, dimension_id, tags, start_ms, end_ms, text, evidence_ids}`.
Kinds are the taxonomy `rules.open_text_segment_kinds`. Dimension is a valid
taxonomy dimension or null; tags use that dimension. Text is interpretation or
description; verbatim original material remains in the evidence registry.
Time is null or within the cited evidence interval; no word alignment is invented.
CTA segments each represent one actual occurrence, not a video-level count.

Positive classifications must have their promised structured annotations. Each
non-none `cta.action` tag needs a matching same-source CTA event; CTA position
needs a same-source event. Each known information type needs a matching typed
same-source unit. Each known structure role needs a matching typed same-source
structure segment; non-weak structure types need at least one such segment.
Known topic problems need same-source `topic_problem` text, and specific
non-broad topic granularity needs same-source `topic_subject` text. Same-source
means intersecting evidence IDs. Unsupported positive classifications become
unknown with an explicit reason, rather than implying an event/unit count of
zero. Weak structures, absent CTA, unknown/not-applicable fields and visual
ambience do not force invented units or paragraphs. Coarse topic categories
remain valid independently of missing concrete subjects.

The opening sentence can be extracted deterministically from the first original
transcript interval. Its time range remains that whole source interval, even
when the sentence ends earlier in its text. A deterministic first-three-second
quote is added only when the original interval itself ends at or before 3000ms;
it is never manufactured by cutting words from a straddling ASR interval.

`InformationUnit = {id, type_tag, text, evidence_ids, duplicate_of}`.
Type is from `value.information_type`. Duplicate targets must refer to an earlier
unit. These are semantic annotations, not objective measurements; code counts
deduplicated units rather than allowing the model to supply totals or percentages.

## Module callback

`build_content_analysis(media, transcript, visuals, request_classification,
                        profile="standard", metrics=None, transcript_source="asr")`

The callback receives `(module_key, payload, max_output_tokens)` and returns
`{classifications: [...], segments: [...], information_units: [...]}`. Its output
cannot create/modify evidence or metrics. Use lazy
`create_content_response_model(module_key=None)` for the SDK response model;
the stdlib validation path imports no Pydantic/OpenAI/Instructor modules.
Module payload contains only its bounded dimensions, exact source evidence,
upstream valid classifications, and measured metadata. There are at most four
logical modules; the provider may retry a confirmed output-token truncation once
with a larger limit (at most eight API attempts across all four modules). There
are no unbounded model repair retries. Input estimates, SDK schema reserve,
initial output tokens, per-module output caps and attempt caps are defined once
in the taxonomy `budgets.standard` / `budgets.max` metadata. The declared input
estimate is one CJK character per token and four other characters per token;
it is an estimate, not a claim of actual tokenizer usage. Evidence is sampled
within the remaining total payload budget, first preserving first/opening
evidence and complete ordered temporal bundles. Coverage is explicit; an
otherwise valid absence claim from a representative source sample is normalized
to unknown with `absence_not_verifiable_from_representative_sample`. This does
not create a fake none label and does not invalidate normal sampled reports.

Visual known classifications require actual vision observations. Motion,
stability, transitions and cut-pattern classifications additionally require a
valid ordered group of at least three real frames and reference its temporal
evidence. A lone frame or a scene-candidate count is insufficient.

## Comparison

Select one analysis revision per video. Group compatible taxonomy version,
metrics version and sampling strategy/config; do not silently mix legacy data.
Primary share and multi-label occurrence rates divide by field-known videos;
show known/unknown/not-acquired/not-applicable counts. None is known absence.
Multi-label rates may sum above 100%. CTA video prevalence and occurrence
counts have different denominators. Failed validation is visible and excluded
from approved comparison samples until reviewed or reanalyzed.
