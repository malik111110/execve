// Package redismem provides Redis-backed semantic caching and long-term agent
// memory using Redis Search vector indexes.  It is an optional layer; when
// AGENT_REDIS_ADDR is not set the factory returns nil stubs and the agent
// continues without Redis.
package redismem

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	defaultRedisAddr = "127.0.0.1:6379"
	dialTimeout      = 3 * time.Second
	readTimeout      = 5 * time.Second
	writeTimeout     = 3 * time.Second
)

// Client wraps a redis.Client with helpers used across this package.
type Client struct {
	rdb *redis.Client
}

// NewClientFromEnv reads AGENT_REDIS_ADDR (and optionally AGENT_REDIS_PASSWORD
// / AGENT_REDIS_DB) and returns a connected Client.  Returns (nil, nil) when
// AGENT_REDIS_ADDR is empty, meaning Redis is disabled.
func NewClientFromEnv() (*Client, error) {
	addr := strings.TrimSpace(os.Getenv("AGENT_REDIS_ADDR"))
	if addr == "" {
		return nil, nil
	}

	password := os.Getenv("AGENT_REDIS_PASSWORD")
	dbNum := 0

	rdb := redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           dbNum,
		DialTimeout:  dialTimeout,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
	})

	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, fmt.Errorf("redis ping failed: %w", err)
	}

	return &Client{rdb: rdb}, nil
}

// Close releases the underlying Redis connection pool.
func (c *Client) Close() error {
	if c == nil || c.rdb == nil {
		return nil
	}

	return c.rdb.Close()
}

// Raw exposes the underlying *redis.Client for use within this package only.
func (c *Client) Raw() *redis.Client {
	return c.rdb
}
