package tools

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	defaultTerminalPoolName       = "default"
	defaultTerminalProcessHistory = 96
)

type TerminalStartRequest struct {
	WorkspaceRoot string
	TerminalName  string
	Command       string
	Shell         string
	Timeout       time.Duration
	MaxStoredLines int
	MaxBufferBytes int
}

type TerminalLookupRequest struct {
	TerminalID   string
	WorkspaceRoot string
	TerminalName  string
}

type TerminalManager struct {
	mu            sync.Mutex
	sequence      uint64
	maxProcesses  int
	processesByID map[string]*TerminalProcess
	poolToID      map[string]string
	startOrder    []string
}

func NewTerminalManager() *TerminalManager {
	return &TerminalManager{
		maxProcesses:  defaultTerminalProcessHistory,
		processesByID: make(map[string]*TerminalProcess),
		poolToID:      make(map[string]string),
	}
}

var (
	defaultTerminalManagerOnce sync.Once
	defaultTerminalManager     *TerminalManager
)

func DefaultTerminalManager() *TerminalManager {
	defaultTerminalManagerOnce.Do(func() {
		defaultTerminalManager = NewTerminalManager()
	})

	return defaultTerminalManager
}

func (m *TerminalManager) Start(request TerminalStartRequest) (*TerminalProcess, bool, error) {
	workspaceRoot := strings.TrimSpace(request.WorkspaceRoot)
	if workspaceRoot == "" {
		return nil, false, fmt.Errorf("workspace_root is required")
	}

	command := strings.TrimSpace(request.Command)
	if command == "" {
		return nil, false, fmt.Errorf("command is required")
	}

	normalizedRoot := filepath.Clean(workspaceRoot)
	terminalName := normalizeTerminalName(request.TerminalName)
	poolKey := terminalPoolKey(normalizedRoot, terminalName)

	m.mu.Lock()
	defer m.mu.Unlock()

	if existingID, ok := m.poolToID[poolKey]; ok {
		if existing := m.processesByID[existingID]; existing != nil {
			if existing.IsRunning() {
				if strings.TrimSpace(existing.Command()) == command {
					return existing, true, nil
				}

				return nil, false, fmt.Errorf(
					"terminal %q is busy with %q (terminal_id=%s); use continue semantics",
					terminalName,
					existing.Command(),
					existingID,
				)
			}
		}
	}

	m.sequence += 1
	terminalID := fmt.Sprintf("term-%d", m.sequence)

	process, err := newTerminalProcess(TerminalStartOptions{
		TerminalID:     terminalID,
		TerminalName:   terminalName,
		WorkspaceRoot:  normalizedRoot,
		Command:        command,
		Shell:          request.Shell,
		Timeout:        request.Timeout,
		MaxStoredLines: request.MaxStoredLines,
		MaxBufferBytes: request.MaxBufferBytes,
	})
	if err != nil {
		return nil, false, err
	}

	m.processesByID[terminalID] = process
	m.poolToID[poolKey] = terminalID
	m.startOrder = append(m.startOrder, terminalID)
	m.pruneCompletedLocked()

	return process, false, nil
}

func (m *TerminalManager) Resolve(request TerminalLookupRequest) (*TerminalProcess, error) {
	lookupID := strings.TrimSpace(request.TerminalID)

	m.mu.Lock()
	defer m.mu.Unlock()

	if lookupID == "" {
		workspaceRoot := strings.TrimSpace(request.WorkspaceRoot)
		if workspaceRoot == "" {
			return nil, fmt.Errorf("workspace_root is required when terminal_id is not provided")
		}

		poolKey := terminalPoolKey(filepath.Clean(workspaceRoot), normalizeTerminalName(request.TerminalName))
		lookupID = m.poolToID[poolKey]
	}

	if lookupID == "" {
		return nil, fmt.Errorf("terminal not found")
	}

	process := m.processesByID[lookupID]
	if process == nil {
		return nil, fmt.Errorf("terminal not found: %s", lookupID)
	}

	return process, nil
}

func normalizeTerminalName(candidate string) string {
	name := strings.TrimSpace(candidate)
	if name == "" {
		return defaultTerminalPoolName
	}

	return name
}

func terminalPoolKey(workspaceRoot string, terminalName string) string {
	return filepath.Clean(workspaceRoot) + "::" + normalizeTerminalName(terminalName)
}

func (m *TerminalManager) pruneCompletedLocked() {
	if m.maxProcesses <= 0 || len(m.processesByID) <= m.maxProcesses {
		return
	}

	retainedOrder := make([]string, 0, len(m.startOrder))

	for _, terminalID := range m.startOrder {
		process := m.processesByID[terminalID]
		if process == nil {
			continue
		}

		if len(m.processesByID) > m.maxProcesses && process.IsCompleted() {
			delete(m.processesByID, terminalID)
			for key, mappedID := range m.poolToID {
				if mappedID == terminalID {
					delete(m.poolToID, key)
				}
			}
			continue
		}

		retainedOrder = append(retainedOrder, terminalID)
	}

	m.startOrder = retainedOrder
}