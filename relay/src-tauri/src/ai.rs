use crate::store::{self, Provider};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Deserialize, Serialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ToolOutput {
    pub id: String,
    pub content: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Call {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}
#[derive(Serialize)]
pub struct Step {
    pub text: String,
    pub calls: Vec<Call>,
    pub history: Vec<Value>,
    pub usage: Value,
}

pub fn request_body(
    p: &Provider,
    mut history: Vec<Value>,
    input: &str,
    results: &[ToolOutput],
    tools: &[ToolDef],
) -> (Value, Vec<Value>) {
    if !input.is_empty() {
        history.push(json!({"role":"user","content":input}));
    }
    if p.id == "claude" {
        if !results.is_empty() {
            history.push(json!({"role":"user", "content": results.iter().map(|r| json!({"type":"tool_result","tool_use_id":r.id,"content":r.content})).collect::<Vec<_>>() }));
        }
        let mut body = json!({"model":p.model,"max_tokens":4096,"messages":history});
        if !tools.is_empty() {
            body["tools"] = json!(tools.iter().map(|t| json!({"name":t.name,"description":t.description,"input_schema":t.parameters})).collect::<Vec<_>>());
        }
        (body, history)
    } else if p.id == "openai" {
        for r in results {
            history.push(json!({"type":"function_call_output","call_id":r.id,"output":r.content}));
        }
        let body = json!({"model":p.model,"input":history,"store":false,"tools":tools.iter().map(|t| json!({"type":"function","name":t.name,"description":t.description,"parameters":t.parameters,"strict":false})).collect::<Vec<_>>()});
        (body, history)
    } else {
        for r in results {
            history.push(json!({"role":"tool","tool_call_id":r.id,"content":r.content}));
        }
        let mut body = json!({"model":p.model,"messages":history,"stream":false});
        if !tools.is_empty() {
            body["tools"] = json!(tools.iter().map(|t| json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.parameters}})).collect::<Vec<_>>());
        }
        (body, history)
    }
}
fn arguments(v: &Value) -> Result<Value, String> {
    let value = if let Some(s) = v.as_str() {
        serde_json::from_str(s).map_err(|_| "The model produced invalid JSON tool arguments.")?
    } else {
        v.clone()
    };
    if !value.is_object() {
        return Err("The model's tool arguments were not a JSON object.".into());
    }
    Ok(value)
}
pub fn parse_response(
    provider: &str,
    response: Value,
    mut history: Vec<Value>,
) -> Result<Step, String> {
    let mut calls = vec![];
    let mut text = String::new();
    if provider == "openai" {
        let items = response["output"]
            .as_array()
            .ok_or("Provider response has no output.")?;
        for item in items {
            if item["type"] == "function_call" {
                calls.push(Call {
                    id: item["call_id"].as_str().ok_or("Missing call ID")?.into(),
                    name: item["name"].as_str().ok_or("Missing tool name")?.into(),
                    arguments: arguments(&item["arguments"])?,
                });
            }
            if let Some(content) = item["content"].as_array() {
                for part in content {
                    if let Some(t) = part["text"].as_str() {
                        text.push_str(t);
                    }
                }
            }
        }
        history.extend(items.clone());
    } else if provider == "claude" {
        let items = response["content"]
            .as_array()
            .ok_or("Provider response has no content.")?;
        for item in items {
            if item["type"] == "tool_use" {
                calls.push(Call {
                    id: item["id"].as_str().ok_or("Missing call ID")?.into(),
                    name: item["name"].as_str().ok_or("Missing tool name")?.into(),
                    arguments: arguments(&item["input"])?,
                });
            }
            if let Some(t) = item["text"].as_str() {
                text.push_str(t);
            }
        }
        history.push(json!({"role":"assistant","content":items}));
    } else {
        let message = response["choices"][0]["message"].clone();
        if !message.is_object() {
            return Err("Provider response has no assistant message.".into());
        }
        text = message["content"].as_str().unwrap_or_default().into();
        if let Some(items) = message["tool_calls"].as_array() {
            for item in items {
                calls.push(Call {
                    id: item["id"].as_str().ok_or("Missing call ID")?.into(),
                    name: item["function"]["name"]
                        .as_str()
                        .ok_or("Missing tool name")?
                        .into(),
                    arguments: arguments(&item["function"]["arguments"])?,
                });
            }
        }
        // Preserve provider-specific metadata (including Gemini thought signatures).
        history.push(message);
    }
    Ok(Step {
        text,
        calls,
        history,
        usage: response["usage"].clone(),
    })
}
pub fn endpoint(p: &Provider) -> Result<String, String> {
    Ok(match p.id.as_str() {
        "openai" => "https://api.openai.com/v1/responses".into(),
        "claude" => "https://api.anthropic.com/v1/messages".into(),
        "gemini" => {
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".into()
        }
        "local" => {
            format!(
                "{}/v1/chat/completions",
                p.base_url.trim_end_matches('/').trim_end_matches("/v1")
            )
        }
        _ => return Err("Unknown AI provider".into()),
    })
}
pub async fn step(
    p: Provider,
    history: Vec<Value>,
    input: String,
    results: Vec<ToolOutput>,
    tools: Vec<ToolDef>,
    local_token: Option<String>,
) -> Result<Step, String> {
    if p.model.trim().is_empty() {
        return Err("Choose a model in Models first.".into());
    }
    let endpoint = endpoint(&p)?;
    let (body, history) = request_body(&p, history, &input, &results, &tools);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.post(endpoint).json(&body);
    let mut key = local_token.unwrap_or_default();
    if p.id == "local" && !key.is_empty() {
        request = request.bearer_auth(&key);
    }
    if ["openai", "gemini", "claude"].contains(&p.id.as_str()) {
        key = store::secret(&format!("provider:{}", p.id))?;
        if key.is_empty() {
            return Err("Save your API key in Models first.".into());
        }
        request = if p.id == "claude" {
            request
                .header("x-api-key", &key)
                .header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(&key)
        };
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Could not reach provider: {e}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| format!("Provider returned a non-JSON response ({status})."))?;
    if !status.is_success() {
        let mut detail = value["error"]["message"]
            .as_str()
            .unwrap_or("Request rejected")
            .to_string();
        if !key.is_empty() {
            detail = detail.replace(&key, "[redacted]");
        }
        return Err(format!("Provider {status}: {detail}"));
    }
    parse_response(&p.id, value, history)
}
