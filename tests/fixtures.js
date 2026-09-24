"use strict";

/**
 * A normal PHP change: two context lines, one deletion, three additions.
 * New-file line numbers for the added lines are 12, 13 and 14.
 */
const PHP_DIFF = `diff --git a/app/Services/ReportService.php b/app/Services/ReportService.php
index 1111111..2222222 100644
--- a/app/Services/ReportService.php
+++ b/app/Services/ReportService.php
@@ -10,4 +10,6 @@ class ReportService
     public function build(array $ids): Collection
     {
-        return Report::whereIn('id', $ids)->get();
+        return Report::whereIn('id', $ids)
+            ->with('author')
+            ->get();
     }
`;

const DELETED_FILE_DIFF = `diff --git a/app/Legacy/Old.php b/app/Legacy/Old.php
deleted file mode 100644
index 1111111..0000000
--- a/app/Legacy/Old.php
+++ /dev/null
@@ -1,2 +0,0 @@
-<?php
-// gone
`;

const BINARY_DIFF = `diff --git a/public/logo.png b/public/logo.png
index 1111111..2222222 100644
Binary files a/public/logo.png and b/public/logo.png differ
`;

const LOCKFILE_DIFF = `diff --git a/yarn.lock b/yarn.lock
index 1111111..2222222 100644
--- a/yarn.lock
+++ b/yarn.lock
@@ -1,2 +1,3 @@
 # yarn lockfile v1
+added-package@1.0.0:
 other
`;

/** Two separate hunks in one file, for exercising the request-splitting path. */
const TWO_CHUNK_DIFF = `diff --git a/resources/js/views/Report.vue b/resources/js/views/Report.vue
index 1111111..2222222 100644
--- a/resources/js/views/Report.vue
+++ b/resources/js/views/Report.vue
@@ -5,2 +5,3 @@
 const a = 1;
+const b = 2;
 const c = 3;
@@ -40,2 +41,3 @@
 const d = 4;
+const e = 5;
 const f = 6;
`;

function baseConfig(overrides) {
  return Object.assign(
    {
      githubToken: "token",
      openAIApiKey: "key",
      model: "gpt-4o",
      endpoint: "responses",
      temperature: 0.2,
      maxOutputTokens: 2000,
      promptOverride: "",
      projectContext: "",
      excludePatterns: [],
      triggerPhrase: "@openai review",
      allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
      pullNumber: null,
      maxFiles: 40,
      maxComments: 25,
      maxRequestChars: 12000,
      concurrency: 3,
    },
    overrides
  );
}

function commentEvent(overrides) {
  const base = {
    action: "created",
    issue: { number: 42, pull_request: { url: "https://api.github.com/..." } },
    comment: {
      id: 999,
      body: "@openai review",
      author_association: "MEMBER",
      user: { login: "dev", type: "User" },
    },
    repository: { name: "rocks-api", owner: { login: "full-scale-teams" } },
  };

  const merged = Object.assign({}, base, overrides);
  if (overrides && overrides.comment) {
    merged.comment = Object.assign({}, base.comment, overrides.comment);
  }
  if (overrides && overrides.issue !== undefined) {
    merged.issue = overrides.issue;
  }

  return merged;
}

module.exports = {
  PHP_DIFF,
  DELETED_FILE_DIFF,
  BINARY_DIFF,
  LOCKFILE_DIFF,
  TWO_CHUNK_DIFF,
  baseConfig,
  commentEvent,
};
