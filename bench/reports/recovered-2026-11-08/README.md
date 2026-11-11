# Recovered partial baseline

This is the run started by the November 8 progress thread, from source revision `02bbb16`.
The run stopped after 157 of 183 intended cells: agentweb 53 tasks, competitors 52 each.
The summary uses only the 52 tasks with a result for every tool.

This historical result is incomplete, single-trial, and infrastructure-confounded. Agent-browser
used version 0.41.2 and Playwright MCP 0.0.84 according to the original baseline configuration;
there is no actual-binary provenance manifest. Some browser starts failed with resource/thread
errors. Two agent-browser failures also involved harness restrictions. The old row schema did
not record permission-denial counts: the summary shows those as unrecorded, not zero.

One Playwright verdict changed from fail to pass because the five-products grader incorrectly
rejected a correct list followed by an explanation mentioning the runner-up. The same corrected
grade was applied to every tool. Raw evidence is preserved; this changes no model answer or cost.

The full original transcripts remain under the project checkout's git-ignored
`bench/out/baseline-02bbb16/transcripts`; this report preserves the compact recorded rows and
input/grader hashes. It is a historical checkpoint, not evidence against today's tools.
