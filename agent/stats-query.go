// Command stats-query reads sing-box's V2Ray API using sing-box's own protobuf schema.
// Xray's CLI cannot query this API: the two engines use different gRPC service names.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/sagernet/sing-box/experimental/v2rayapi"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	server := flag.String("server", "127.0.0.1:10086", "sing-box statistics API address")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := grpc.NewClient(*server, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil { fail(err) }
	defer conn.Close()
	var response v2rayapi.QueryStatsResponse
	err = conn.Invoke(ctx, "/v2ray.core.app.stats.command.StatsService/QueryStats",
		&v2rayapi.QueryStatsRequest{Patterns: []string{"inbound>>>"}}, &response)
	if err != nil { fail(err) }
	result := struct { Stat []struct { Name string `json:"name"`; Value string `json:"value"` } `json:"stat"` }{}
	for _, stat := range response.Stat {
		result.Stat = append(result.Stat, struct { Name string `json:"name"`; Value string `json:"value"` }{
			Name: stat.Name, Value: fmt.Sprint(stat.Value),
		})
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil { fail(err) }
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
