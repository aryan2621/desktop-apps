//! A deliberately small, side-effect-free MCP fixture bundled for onboarding and smoke tests.
use serde_json::{json, Value};
use std::io::{BufRead, Write};
pub fn response(request: Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let result = match request["method"].as_str().unwrap_or_default() {
        "initialize" => {
            json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{},"resources":{},"prompts":{}},"serverInfo":{"name":"relay-example","version":"1.0.0"}})
        }
        "ping" => json!({}),
        "tools/list" => {
            json!({"tools":[{"name":"echo","description":"Echo a message back. Useful for checking connectivity and model tool calls.","inputSchema":{"type":"object","properties":{"message":{"type":"string","description":"The message to echo"}},"required":["message"]},"annotations":{"readOnlyHint":true}},{"name":"add","description":"Add two numbers and return the sum.","inputSchema":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]},"annotations":{"readOnlyHint":true}}]})
        }
        "tools/call" => {
            let p = &request["params"];
            let a = &p["arguments"];
            match p["name"].as_str() {
                Some("echo") => match a["message"].as_str() {
                    Some(m) => json!({"content":[{"type":"text","text":m}]}),
                    None => {
                        json!({"isError":true,"content":[{"type":"text","text":"message must be a string"}]})
                    }
                },
                Some("add") => match (a["a"].as_f64(), a["b"].as_f64()) {
                    (Some(a), Some(b)) => {
                        json!({"content":[{"type":"text","text":(a+b).to_string()}]})
                    }
                    _ => {
                        json!({"isError":true,"content":[{"type":"text","text":"a and b must be numbers"}]})
                    }
                },
                _ => {
                    return Some(
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Unknown tool"}}),
                    )
                }
            }
        }
        "resources/list" => {
            json!({"resources":[{"uri":"relay://welcome","name":"Welcome","mimeType":"text/plain"}]})
        }
        "resources/read" if request["params"]["uri"] == "relay://welcome" => {
            json!({"contents":[{"uri":"relay://welcome","mimeType":"text/plain","text":"Welcome to Relay. This resource comes from a real local MCP server."}]})
        }
        "prompts/list" => {
            json!({"prompts":[{"name":"test-tools","description":"A simple tool-testing prompt"}]})
        }
        "prompts/get" if request["params"]["name"] == "test-tools" => {
            json!({"messages":[{"role":"user","content":{"type":"text","text":"Use add to calculate 7 + 5, then echo the answer."}}]})
        }
        _ => {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}),
            )
        }
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}
pub fn serve() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if let Ok(request) = serde_json::from_str(&line) {
            if let Some(response) = response(request) {
                if writeln!(out, "{response}")
                    .and_then(|_| out.flush())
                    .is_err()
                {
                    break;
                }
            }
        }
    }
}
