package redismem

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// cacheIndexName is the Redis Search index used for semantic cache lookup.
	cacheIndexName = "idx:semantic_cache"

	// cacheKeyPrefix prefixes every cached entry hash.
	cacheKeyPrefix = "scache:"

	// defaultCacheThreshold is the minimum cosine similarity to consider a
	// cache hit.  1.0 = identical vector; 0.92 is intentionally conservative
	// so only very close paraphrases reuse a cached reply.
	defaultCacheThreshold = float32(0.92)

	// defaultCacheTTL is how long a cache entry is kept before Redis evicts it.
	defaultCacheTTL = 24 * time.Hour

	// embeddingDim is the expected vector dimension.  This must match the
	// embedding model in use.  When the actual embedding differs the index
	// must be rebuilt.  We store it dynamically at index creation time.
	embeddingDimFallback = 768
)

// SemanticCache stores LLM responses keyed by their prompt embedding and
// retrieves hits using approximate KNN search.
type SemanticCache struct {
	client    *Client
	threshold float32
	ttl       time.Duration
	dim       int
}

// NewSemanticCache returns a SemanticCache backed by c.  A nil Client
// produces a no-op cache so the caller never needs to guard against nil.
func NewSemanticCache(c *Client) *SemanticCache {
	return &SemanticCache{
		client:    c,
		threshold: defaultCacheThreshold,
		ttl:       defaultCacheTTL,
		dim:       embeddingDimFallback,
	}
}

// EnsureIndex creates the Redis Search vector index if it doesn't exist.
// Call once at startup (after the first real embedding is available so dim
// is known).
func (sc *SemanticCache) EnsureIndex(ctx context.Context, dim int) error {
	if sc.client == nil {
		return nil
	}

	if dim > 0 {
		sc.dim = dim
	}

	rdb := sc.client.Raw()

	// FT.CREATE is idempotent with SKIPINITIALSCAN; ignore "Index already exists".
	cmd := rdb.Do(ctx,
		"FT.CREATE", cacheIndexName,
		"ON", "HASH",
		"PREFIX", "1", cacheKeyPrefix,
		"SCHEMA",
		"embedding", "VECTOR", "HNSW", "6",
		"TYPE", "FLOAT32",
		"DIM", fmt.Sprintf("%d", sc.dim),
		"DISTANCE_METRIC", "COSINE",
		"response", "TEXT", "NOSTEM",
	)
	if err := cmd.Err(); err != nil && !strings.Contains(err.Error(), "Index already exists") {
		return fmt.Errorf("create semantic cache index: %w", err)
	}

	return nil
}

// cacheEntry is what we store in the Redis hash.
type cacheEntry struct {
	Prompt    string `json:"prompt"`
	Response  string `json:"response"`
	CreatedAt string `json:"created_at"`
}

// Get looks up a cached response for the given embedding.  Returns ("", false)
// on a miss or when Redis is unavailable.
func (sc *SemanticCache) Get(ctx context.Context, embedding []float32) (string, bool) {
	if sc.client == nil || len(embedding) == 0 {
		return "", false
	}

	blob := float32SliceToBytes(embedding)

	// KNN query via Redis Search.
	query := fmt.Sprintf("*=>[KNN 1 @embedding $vec AS score]")
	cmd := sc.client.Raw().Do(ctx,
		"FT.SEARCH", cacheIndexName,
		query,
		"PARAMS", "2", "vec", blob,
		"SORTBY", "score",
		"LIMIT", "0", "1",
		"RETURN", "3", "score", "response", "prompt",
		"DIALECT", "2",
	)
	if cmd.Err() != nil {
		return "", false
	}

	results, ok := cmd.Val().([]any)
	if !ok || len(results) < 3 {
		return "", false
	}

	// results[0] = total hits (int64), results[1] = key, results[2] = field slice
	totalHits, _ := results[0].(int64)
	if totalHits == 0 {
		return "", false
	}

	fields, ok := results[2].([]any)
	if !ok {
		return "", false
	}

	fieldMap := parseFieldPairs(fields)

	score := parseFloat32(fieldMap["score"])
	// Redis returns cosine distance (0=identical), so similarity = 1 - distance.
	similarity := float32(1) - score
	if similarity < sc.threshold {
		return "", false
	}

	response := strings.TrimSpace(fieldMap["response"])
	if response == "" {
		return "", false
	}

	return response, true
}

// Set stores a prompt+response pair in the cache, indexed by the prompt embedding.
func (sc *SemanticCache) Set(ctx context.Context, prompt string, embedding []float32, response string) error {
	if sc.client == nil || len(embedding) == 0 {
		return nil
	}

	key := cacheKeyPrefix + hashPrompt(prompt)
	blob := float32SliceToBytes(embedding)

	entry := cacheEntry{
		Prompt:    prompt,
		Response:  response,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}

	entryJSON, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("marshal cache entry: %w", err)
	}

	rdb := sc.client.Raw()
	pipe := rdb.Pipeline()
	pipe.HSet(ctx, key,
		"embedding", blob,
		"response", response,
		"prompt", prompt,
		"meta_json", string(entryJSON),
	)
	pipe.Expire(ctx, key, sc.ttl)
	_, err = pipe.Exec(ctx)

	return err
}

// --- helpers -----------------------------------------------------------------

func float32SliceToBytes(v []float32) []byte {
	b := make([]byte, len(v)*4)
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(f))
	}

	return b
}

func parseFieldPairs(fields []any) map[string]string {
	m := make(map[string]string, len(fields)/2)
	for i := 0; i+1 < len(fields); i += 2 {
		k, _ := fields[i].(string)
		v, _ := fields[i+1].(string)
		if k != "" {
			m[k] = v
		}
	}

	return m
}

func parseFloat32(s string) float32 {
	var f float64
	if _, err := fmt.Sscanf(s, "%f", &f); err != nil {
		return 1 // default to maximum distance (no match) on parse error
	}

	return float32(f)
}

func hashPrompt(prompt string) string {
	// A simple deterministic ID based on the first 64 bytes of the prompt.
	// Full uniqueness comes from the vector similarity check, not this key.
	const maxLen = 64
	s := strings.TrimSpace(prompt)
	if len(s) > maxLen {
		s = s[:maxLen]
	}

	h := fnv32a(s)
	return fmt.Sprintf("%08x", h)
}

func fnv32a(s string) uint32 {
	const (
		prime  = uint32(16777619)
		offset = uint32(2166136261)
	)

	h := offset
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= prime
	}

	return h
}

// Ensure redis.Nil is imported so the package compiles even when unused.
var _ = redis.Nil
