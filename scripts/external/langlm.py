"""Measure AnthonyFC/langlm-de (German GEC, base-format) through Ollama /api/generate in raw mode.

This model is NOT a chat model and corrects one tokenised sentence, so it cannot use the plugin's
chat+JSON protocol. It is German only, so English and mixed samples are skipped (rows omitted).

Setup (scratch, not part of the plugin):
  ollama create langlm-de -f Modelfile   # Modelfile: FROM ./langlm-de-755mb.gguf, TEMPLATE "{{ .Prompt }}"
Usage: python langlm.py <samples.json> <out.rows.json>
"""
import json, re, sys, time, urllib.request

OLLAMA = "http://localhost:11434"
MODEL = "langlm-de"
PROMPT = "Correct the German sentence, then list what changed.\n\nInput: {text}\nOutput:"


def post(path, body):
    request = urllib.request.Request(OLLAMA + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def tokenise(text):  # training data has a space before punctuation
    return re.sub(r"\s+", " ", re.sub(r"([.,;:!?()])", r" \1 ", text)).strip()


def detokenise(text):
    return re.sub(r"\s+([.,;:!?)])", r"\1", re.sub(r"\(\s+", "(", text))


def correct(text):
    reply = post("/api/generate", {"model": MODEL, "raw": True, "stream": False, "keep_alive": "5m",
                                   "prompt": PROMPT.format(text=tokenise(text)),
                                   "options": {"temperature": 0, "num_predict": 200, "num_ctx": 1024, "stop": ["\n"]}})
    return detokenise(json.loads(reply["response"].strip())["correction"])


samples, out = json.load(open(sys.argv[1])), sys.argv[2]
post("/api/generate", {"model": MODEL, "keep_alive": 0})  # cold start
time.sleep(2)
rows = []
for sample in samples:
    if sample["kind"] not in ("de-error", "de-caps", "clean-de"):
        continue
    started, corrected, error = time.perf_counter(), "", ""
    try:
        corrected = correct(sample["text"])
    except Exception as exc:  # recorded, scored as unchanged
        error = str(exc)
    rows.append({"model": "langlm-de (raw, German only)", **sample, "corrected": corrected, "error": error,
                 "ms": round((time.perf_counter() - started) * 1000), "cold": not rows})
memory = json.load(urllib.request.urlopen(OLLAMA + "/api/ps"))
json.dump({"model": "langlm-de (raw, German only)", "runtime": "ollama raw completion", "rows": rows, "memory": memory},
          open(out, "w"), indent=2, ensure_ascii=False)
print(len(rows), "German rows")
