-- CodeGraph's index in DuckDB (packages/codegraph-store/DESIGN.md).
--
-- Written for DuckDB, not translated from schema.sql: 64-bit integers,
-- sequences for row ids, no triggers or FTS5 (search uses node_tokens).
-- DuckDB's foreign keys don't cascade, so QueryBuilder's delete methods
-- remove dependent rows themselves, and none are declared here.
-- Indexes: keys that enforce uniqueness or that INSERT OR REPLACE / OR
-- IGNORE need, and ART indexes for the point lookups indexing and queries
-- make one row at a time (by name, qualified name, lowered name, file, edge
-- end): DuckDB uses them for an equality filter, bound or literal (on 100k
-- rows, about 170 us a lookup against 900 us scanning; .cache/spike/
-- point-lookup.mjs). They are declared after the tables, below.

CREATE TABLE IF NOT EXISTS schema_versions (
    version BIGINT PRIMARY KEY,
    applied_at BIGINT NOT NULL,
    description VARCHAR
);

CREATE TABLE IF NOT EXISTS nodes (
    id VARCHAR PRIMARY KEY,
    kind VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    qualified_name VARCHAR NOT NULL,
    file_path VARCHAR NOT NULL,
    language VARCHAR NOT NULL,
    start_line BIGINT NOT NULL,
    end_line BIGINT NOT NULL,
    start_column BIGINT NOT NULL,
    end_column BIGINT NOT NULL,
    docstring VARCHAR,
    signature VARCHAR,
    visibility VARCHAR,
    is_exported BIGINT DEFAULT 0,
    is_async BIGINT DEFAULT 0,
    is_static BIGINT DEFAULT 0,
    is_abstract BIGINT DEFAULT 0,
    decorators VARCHAR,       -- JSON array
    type_parameters VARCHAR,  -- JSON array
    return_type VARCHAR,
    updated_at BIGINT NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS edges_id;
CREATE TABLE IF NOT EXISTS edges (
    id BIGINT PRIMARY KEY DEFAULT nextval('edges_id'),
    source VARCHAR NOT NULL,
    target VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    metadata VARCHAR,         -- JSON object
    line BIGINT,
    col BIGINT,
    provenance VARCHAR DEFAULT NULL
    -- An edge's identity is (source, target, kind, line, col), a missing line
    -- or col counting as -1. SQLite enforced it with an expression index;
    -- DuckDB indexes columns only and treats NULLs as distinct, so the edge
    -- insert methods skip an edge whose identity exists (NOT EXISTS).
);

CREATE TABLE IF NOT EXISTS files (
    path VARCHAR PRIMARY KEY,
    content_hash VARCHAR NOT NULL,
    language VARCHAR NOT NULL,
    size BIGINT NOT NULL,
    modified_at BIGINT NOT NULL,
    indexed_at BIGINT NOT NULL,
    node_count BIGINT DEFAULT 0,
    errors VARCHAR,           -- JSON array
    generated BIGINT NOT NULL DEFAULT 0
);

CREATE SEQUENCE IF NOT EXISTS unresolved_refs_id;
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id BIGINT PRIMARY KEY DEFAULT nextval('unresolved_refs_id'),
    from_node_id VARCHAR NOT NULL,
    reference_name VARCHAR NOT NULL,
    reference_kind VARCHAR NOT NULL,
    line BIGINT NOT NULL,
    col BIGINT NOT NULL,
    candidates VARCHAR,       -- JSON array
    file_path VARCHAR NOT NULL DEFAULT '',
    language VARCHAR NOT NULL DEFAULT 'unknown',
    status VARCHAR NOT NULL DEFAULT 'pending',
    name_tail VARCHAR NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS name_segment_vocab (
    segment VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    PRIMARY KEY (segment, name)
);

-- Search: what SQLite's FTS5 table nodes_fts held, kept by QueryBuilder's
-- node writes (token-search.ts). A row per node: its insertion order (FTS5's
-- rowid, which breaks score ties) and its length in tokens over the five
-- indexed columns; and a row per token, as FTS5's unicode61 tokenizer splits
-- the columns (0 id, 1 name, 2 qualified_name, 3 docstring, 4 signature).
CREATE SEQUENCE IF NOT EXISTS node_search_seq;

CREATE TABLE IF NOT EXISTS node_search (
    node_id VARCHAR PRIMARY KEY,
    seq BIGINT NOT NULL DEFAULT nextval('node_search_seq'),
    length BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_tokens (
    node_id VARCHAR NOT NULL,
    col TINYINT NOT NULL,
    pos INTEGER NOT NULL,
    token VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS synthesis_inputs (
    file_path VARCHAR PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS project_metadata (
    key VARCHAR PRIMARY KEY,
    value VARCHAR NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS nodes_lower_name ON nodes((lower(name)));
CREATE INDEX IF NOT EXISTS nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS edges_target ON edges(target);

INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
VALUES (1, epoch_ms(now()), 'Initial schema');
