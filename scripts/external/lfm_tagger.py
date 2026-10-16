"""Measure LiquidAI/LFM2.5-Encoder-350M-Spellchecker (GECToR-style tagger, transformers, CPU).

Not runnable through Ollama (encoder token tagger with trust_remote_code), so it needs a different runtime.
The model expects whitespace-tokenised input; the samples are tokenised and detokenised around it.
Usage: python lfm_tagger.py <samples.json> <out.rows.json>   (English-language samples only: the model card
documents English correction, so German and mixed samples are skipped.)
"""
import json, re, sys, time
import torch
from transformers import AutoModel

MODEL_ID = "LiquidAI/LFM2.5-Encoder-350M-Spellchecker"


def tokenise(text):
    return re.sub(r"\s+", " ", re.sub(r"([.,;:!?()])", r" \1 ", text)).strip()


def detokenise(text):
    text = re.sub(r"\s+([.,;:!?)])", r"\1", re.sub(r"\(\s+", "(", text))
    return re.sub(r"\bdoes n't\b", "doesn't", text)


started = time.perf_counter()
model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True).float().eval()
load_seconds = time.perf_counter() - started
samples, out = json.load(open(sys.argv[1])), sys.argv[2]
rows = []
for sample in samples:
    if sample["kind"] not in ("en-error", "clean-en"):
        continue
    started, corrected, error = time.perf_counter(), "", ""
    try:
        with torch.no_grad():
            corrected = detokenise(model.correct([tokenise(sample["text"])])[0])
    except Exception as exc:
        error = str(exc)
    rows.append({"model": "LFM2.5-Encoder-350M-Spellchecker (CPU, English only)", **sample, "corrected": corrected, "error": error,
                 "ms": round((time.perf_counter() - started) * 1000), "cold": not rows})
parameters = sum(p.numel() for p in model.parameters())
json.dump({"model": "LFM2.5-Encoder-350M-Spellchecker (CPU, English only)", "runtime": "transformers CPU", "load_seconds": load_seconds,
           "parameters": parameters, "rows": rows}, open(out, "w"), indent=2, ensure_ascii=False)
print(len(rows), "English rows,", parameters, "parameters, load", round(load_seconds, 1), "s")
