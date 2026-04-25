package tools

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

var ErrToolNotFound = errors.New("tool not found")

type Tool interface {
	Name() string
	Run(ctx context.Context, input map[string]any) (map[string]any, error)
}

type Registry struct {
	tools map[string]Tool
}

func NewRegistry() *Registry {
	return &Registry{tools: map[string]Tool{}}
}

func (r *Registry) Register(tool Tool) {
	if tool == nil {
		return
	}

	r.tools[tool.Name()] = tool
}

func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.tools))
	for name := range r.tools {
		names = append(names, name)
	}

	sort.Strings(names)
	return names
}

func (r *Registry) Get(name string) (Tool, bool) {
	tool, ok := r.tools[name]
	return tool, ok
}

func (r *Registry) Run(ctx context.Context, name string, input map[string]any) (map[string]any, error) {
	tool, ok := r.Get(name)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrToolNotFound, name)
	}

	return tool.Run(ctx, input)
}
