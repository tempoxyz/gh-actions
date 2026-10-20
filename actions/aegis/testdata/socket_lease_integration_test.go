package firewall

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/tempoxyz/aegis/internal/credentials"
)

// Copy this test into an Aegis v0.41.0 client checkout; see README.md.
func TestNodeProviderSocketLeaseIntegration(t *testing.T) {
	fixture := os.Getenv("SOCKET_RENEWAL_PROVIDER_FIXTURE")
	if fixture == "" {
		t.Fatal("SOCKET_RENEWAL_PROVIDER_FIXTURE must name socket-lease-provider.cjs")
	}
	for _, count := range []int{1, 12} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "node", fixture)
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd.Stderr = io.Discard
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
			decoder := json.NewDecoder(stdout)
			var ready struct {
				URL string `json:"url"`
			}
			if err = decoder.Decode(&ready); err != nil {
				t.Fatal(err)
			}
			initial, err := credentials.Load(ctx, ready.URL)
			if err != nil {
				t.Fatal(err)
			}
			var expired atomic.Bool
			var unauthorized, refreshes, connections atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				bearer := r.Header.Get("Authorization")
				conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
				if err != nil {
					return
				}
				defer conn.CloseNow()
				connections.Add(1)
				for {
					_, data, err := conn.Read(ctx)
					if err != nil {
						return
					}
					var req websocketScanRequest
					if json.Unmarshal(data, &req) != nil {
						return
					}
					response := websocketScanResponse{RequestID: req.RequestID, Status: 200, Verdict: "block", Reason: "malware"}
					if expired.Load() && bearer == "Bearer "+initial {
						unauthorized.Add(1)
						response.Status = 401
						response.Verdict = "error"
						response.Reason = "http401"
					}
					data, _ = json.Marshal(response)
					if conn.Write(ctx, websocket.MessageText, data) != nil {
						return
					}
				}
			}))
			defer server.Close()
			checker := NewSocket(server.URL+"/api/scan", initial)
			defer checker.Close()
			checker.networkState = func() networkStatus { return networkStatus{online: true, fingerprint: "fixture"} }
			checker.RefreshToken = func(ctx context.Context) (string, error) { refreshes.Add(1); return credentials.Load(ctx, ready.URL) }
			if d, err := checker.Check(ctx, "pkg:npm/rotation-fixture@1"); err != nil || d.Action != "block" {
				t.Fatalf("initial scan action=%s err=%v", d.Action, err)
			}
			if _, err = io.WriteString(stdin, "renew\n"); err != nil {
				t.Fatal(err)
			}
			var renewed struct {
				Renewed bool `json:"renewed"`
			}
			if err = decoder.Decode(&renewed); err != nil || !renewed.Renewed {
				t.Fatal("provider renewal failed")
			}
			expired.Store(true)
			var group sync.WaitGroup
			for range count {
				group.Go(func() {
					d, err := checker.Check(ctx, "pkg:npm/rotation-fixture@2")
					if err != nil || d.Action != "block" || d.Reason != "malware" {
						t.Errorf("after expiry action=%s reason=%s err=%v", d.Action, d.Reason, err)
					}
				})
			}
			group.Wait()
			if refreshes.Load() != 1 {
				t.Errorf("provider refreshes=%d, want one shared refresh", refreshes.Load())
			}
			if unauthorized.Load() == 0 || connections.Load() < 2 {
				t.Errorf("test did not exercise expiry and authenticated reconnect")
			}
			if d, err := checker.Check(ctx, "pkg:npm/rotation-fixture@3"); err != nil || d.Action != "block" {
				t.Fatalf("retained replacement action=%s err=%v", d.Action, err)
			}
			t.Logf("concurrent scans=%d refreshed=%d recovered401s=%d connections=%d; all malware verdicts blocked", count, refreshes.Load(), unauthorized.Load(), connections.Load())
		})
	}
}
