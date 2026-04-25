package redismem

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	// memIndexName is the Redis Search index for long-term agent memory.
	memIndexName = "idx:agent_memory"

	// memKeyPrefix prefixes every memory entry hash.
	memKeyPrefix = "amem:"

	// memRetrieveK is the default number of memory entries retrieved per query.
	memRetrieveK = 5

	// defaultMemTTL is how long a memory entry survives without being accessed.
	defaultMemTTL = 30 * 24 * time.Hour // 30 days
)

// MemoryEntry is a single long-term memory record retrieved from Redis.
type MemoryEntry struct {
	Content     string `json:"content"`
	Source      string `json:"source"`
	WorkspaceID string `json:"workspace_id"`
	CreatedAt   string `json:"created_at"`
	Score       float32
}

// MemoryStore provides dual-tier agent memory backed by Redis Search.
// Short-term memory lives in the SQLite conversation history (already
// implemented).  This store adds long-term semantic memory: important facts
// from past sessions that can be retrieved by vector similarity.
type MemoryStore struct {
	client *Client
	ttl    time.Duration
	dim    int
}

// NewMemoryStore returns a MemoryStore backed by c.  A nil Client produces a
// no-op store.
func NewMemoryStore(c *Client) *MemoryStore {
	return &MemoryStore{
		client: c,
		ttl:    defaultMemTTL,
		dim:    embeddingDimFallback,
	}
}

// EnsureIndex creates the Redis Search vector index for long-term memory.
func (ms *MemoryStore) EnsureIndex(ctx context.Context, dim int) error {
	if ms.client == nil {
		return nil
	}

	if dim > 0 {
		ms.dim = dim
	}

	rdb := ms.client.Raw()

	cmd := rdb.Do(ctx,
		"FT.CREATE", memIndexName,
		"ON", "HASH",
		"PREFIX", "1", memKeyPrefix,
		"SCHEMA",
		"embedding", "VECTOR", "HNSW", "6",
		"TYPE", "FLOAT32",
		"DIM", fmt.Sprintf("%d", ms.dim),
		"DISTANCE_METRIC", "COSINE",
		"content", "TEXT",
		"source", "TAG",
		"workspace_id", "TAG",
	)
	if err := cmd.Err(); err != nil && !strings.Contains(err.Error(), "Index already exists") {
		return fmt.Errorf("create memory index: %w", err)
	}

	return nil
}

// Store persists a memory entry with the given embedding vector.  Duplicate
// content is stored under the same deterministic key, overwriting the
// previous entry and resetting its TTL.
func (ms *MemoryStore) Store(ctx context.Context, workspaceID, source, content string, embedding []float32) error {
	if ms.client == nil || len(embedding) == 0 {
		return nil
	}

	key := memKeyPrefix + hashPrompt(workspaceID+":"+content)
	blob := float32SliceToBytes(embedding)
	now := time.Now().UTC().Format(time.RFC3339)

	metaJSON, err := json.Marshal(map[string]string{
		"content":      content,
		"source":       source,
		"workspace_id": workspaceID,
		"created_at":   now,
	})
	if err != nil {
		return fmt.Errorf("marshal memory meta: %w", err)
	}

	rdb := ms.client.Raw()
	pipe := rdb.Pipeline()
	pipe.HSet(ctx, key,
		"embedding", blob,
		"content", content,
		"source", source,
		"workspace_id", workspaceID,
		"created_at", now,
		"meta_json", string(metaJSON),
	)
	pipe.Expire(ctx, key, ms.ttl)
	_, err = pipe.Exec(ctx)

	return err
}

// Retrieve returns the top-K memory entries most similar to the given
// embedding, filtered to the given workspaceID.  An empty workspaceID skips
// the workspace filter.
func (ms *MemoryStore) Retrieve(ctx context.Context, workspaceID string, embedding []float32, k int) ([]MemoryEntry, error) {
	if ms.client == nil || len(embedding) == 0 {
		return nil, nil
	}

	if k <= 0 {
		k = memRetrieveK
	}

	blob := float32SliceToBytes(embedding)

	var query string
	if strings.TrimSpace(workspaceID) != "" {
		// Escape any special chars in the workspace ID tag value.
		safe := strings.ReplaceAll(workspaceID, "/", "\\/")
		safe = strings.ReplaceAll(safe, ":", "\\:")
		query = fmt.Sprintf("(@workspace_id:{%s})=>[KNN %d @embedding $vec AS score]", safe, k)
	} else {
		query = fmt.Sprintf("*=>[KNN %d @embedding $vec AS score]", k)
	}

	cmd := ms.client.Raw().Do(ctx,
		"FT.SEARCH", memIndexName,
		query,
		"PARAMS", "2", "vec", blob,
		"SORTBY", "score",
		"LIMIT", "0", fmt.Sprintf("%d", k),
		"RETURN", "5", "score", "content", "source", "workspace_id", "created_at",
		"DIALECT", "2",
	)
	if cmd.Err() != nil {
		return nil, fmt.Errorf("memory retrieve: %w", cmd.Err())
	}

	results, ok := cmd.Val().([]any)
	if !ok || len(results) < 1 {
		return nil, nil
	}

	totalHits, _ := results[0].(int64)
	if totalHits == 0 {
		return nil, nil
	}

	entries := make([]MemoryEntry, 0, totalHits)
	for i := 1; i+1 < len(results); i += 2 {
		fields, ok := results[i+1].([]any)
		if !ok {
			continue
		}

		fm := parseFieldPairs(fields)
		score := parseFloat32(fm["score"])
		entries = append(entries, MemoryEntry{
			Content:     fm["content"],
			Source:      fm["source"],
			WorkspaceID: fm["workspace_id"],
			CreatedAt:   fm["created_at"],
			Score:       1 - score, // convert distance to similarity
		})
	}

	return entries, nil
}

// FormatForPrompt turns retrieved memory entries into a compact text block
// suitable for injection into a provider prompt.
func FormatMemoryForPrompt(entries []MemoryEntry) string {
	if len(entries) == 0 {
		return ""
	}

	var b strings.Builder
	for _, e := range entries {
		line := strings.TrimSpace(e.Content)
		if line == "" {
			continue
		}

		b.WriteString("- ")
		if len(line) > 400 {
			line = line[:400] + "..."
		}

		b.WriteString(line)
		b.WriteString("\n")
	}

	return strings.TrimRight(b.String(), "\n")
}
