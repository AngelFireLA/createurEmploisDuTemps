from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import threading
import uuid
from copy import deepcopy
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, send_file


BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = Path(os.environ.get("TIMETABLE_DATA_FILE", BASE_DIR / "data" / "schedule.json"))
LEGACY_FILE = BASE_DIR / "file.csv"
DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
PALETTE = [
    "#6C8CF5", "#F29A68", "#58B89C", "#A77BD8", "#E16E83", "#D7A72F",
    "#4BA3C7", "#7B9B57", "#C878B4", "#5978B9", "#D47D5A", "#43A6A0",
]
STORE_LOCK = threading.RLock()

app = Flask(__name__)


def parse_time(value: str) -> int:
    try:
        hours, minutes = (int(part) for part in value.strip().split(":", 1))
    except (AttributeError, ValueError) as exc:
        raise ValueError("L'heure doit être au format HH:MM.") from exc
    if hours == 24 and minutes == 0:
        return 1440
    if not (0 <= hours <= 23 and 0 <= minutes <= 59):
        raise ValueError("L'heure est en dehors de la journée.")
    return hours * 60 + minutes


def format_time(minutes: int) -> str:
    if minutes == 1440:
        return "24:00"
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def color_for(title: str) -> str:
    digest = hashlib.sha256(title.strip().casefold().encode("utf-8")).digest()
    return PALETTE[int.from_bytes(digest[:2], "big") % len(PALETTE)]


def default_state() -> dict:
    return {
        "version": 1,
        "settings": {"startHour": 7, "endHour": 24, "snapMinutes": 15},
        "events": [],
    }


def legacy_state() -> dict:
    state = default_state()
    if not LEGACY_FILE.exists():
        return state

    with LEGACY_FILE.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if not row or not row.get("Jour") or row["Jour"] not in DAYS:
                continue
            title = (row.get("Activité") or "Sans titre").strip()
            try:
                start = parse_time(row["Heure de début"])
                end = parse_time(row["Heure de fin"])
            except (KeyError, ValueError):
                continue
            if end <= start:
                continue
            state["events"].append({
                "id": uuid.uuid4().hex,
                "day": DAYS.index(row["Jour"]),
                "start": start,
                "end": end,
                "title": title,
                "notes": "",
                "color": color_for(title),
            })
    return state


def validate_state(state: dict) -> dict:
    clean = default_state()
    colors_by_title = {}
    settings = state.get("settings", {}) if isinstance(state, dict) else {}
    start_hour = int(settings.get("startHour", 7))
    end_hour = int(settings.get("endHour", 24))
    snap = int(settings.get("snapMinutes", 15))
    if not (0 <= start_hour < end_hour <= 24):
        start_hour, end_hour = 7, 24
    if snap not in (5, 10, 15, 30, 60):
        snap = 15
    clean["settings"] = {"startHour": start_hour, "endHour": end_hour, "snapMinutes": snap}

    for raw in state.get("events", []):
        try:
            day = int(raw["day"])
            start = int(raw["start"])
            end = int(raw["end"])
            title = str(raw["title"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if not title or not (0 <= day <= 6 and 0 <= start < end <= 1440):
            continue
        color = str(raw.get("color") or color_for(title))
        if not (len(color) == 7 and color.startswith("#")):
            color = color_for(title)
        color = colors_by_title.setdefault(title, color)
        clean["events"].append({
            "id": str(raw.get("id") or uuid.uuid4().hex),
            "day": day,
            "start": start,
            "end": end,
            "title": title[:120],
            "notes": str(raw.get("notes") or "")[:1000],
            "color": color,
        })
    clean["events"].sort(key=lambda event: (event["day"], event["start"], event["end"]))
    return clean


def save_state(state: dict) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = DATA_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, DATA_FILE)


def load_state() -> dict:
    with STORE_LOCK:
        if DATA_FILE.exists():
            try:
                stored = json.loads(DATA_FILE.read_text(encoding="utf-8"))
                state = validate_state(stored)
                if state != stored:
                    save_state(state)
                return state
            except (OSError, json.JSONDecodeError):
                pass
        state = validate_state(legacy_state())
        save_state(state)
        return state


def event_from_payload(payload: dict, existing: dict | None = None) -> dict:
    title = str(payload.get("title", existing["title"] if existing else "")).strip()
    if not title:
        raise ValueError("Ajoutez un nom à l'activité.")
    start_raw = payload.get("start", existing["start"] if existing else None)
    end_raw = payload.get("end", existing["end"] if existing else None)
    start = parse_time(start_raw) if isinstance(start_raw, str) else int(start_raw)
    end = parse_time(end_raw) if isinstance(end_raw, str) else int(end_raw)
    if not (0 <= start < end <= 1440):
        raise ValueError("L'heure de fin doit être après l'heure de début.")
    color = str(payload.get("color") or (existing or {}).get("color") or color_for(title))
    if not (len(color) == 7 and color.startswith("#")):
        raise ValueError("La couleur n'est pas valide.")
    return {
        "id": existing["id"] if existing else uuid.uuid4().hex,
        "day": int(payload.get("day", existing["day"] if existing else 0)),
        "start": start,
        "end": end,
        "title": title[:120],
        "notes": str(payload.get("notes", (existing or {}).get("notes", "")))[:1000],
        "color": color,
    }


def overlaps(first: dict, second: dict) -> bool:
    return first["day"] == second["day"] and first["start"] < second["end"] and second["start"] < first["end"]


def requested_days(payload: dict, fallback: int) -> list[int]:
    values = payload.get("days", [payload.get("day", fallback)])
    days = sorted({int(value) for value in values})
    if not days or any(day < 0 or day > 6 for day in days):
        raise ValueError("Sélectionnez au moins un jour valide.")
    return days


def json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


@app.get("/")
def index():
    load_state()
    return render_template("index.html", days=DAYS)


@app.get("/api/schedule")
def get_schedule():
    return jsonify(load_state())


@app.put("/api/settings")
def update_settings():
    payload = request.get_json(silent=True) or {}
    try:
        start_hour = int(payload["startHour"])
        end_hour = int(payload["endHour"])
        snap = int(payload["snapMinutes"])
        if not (0 <= start_hour < end_hour <= 24) or snap not in (5, 10, 15, 30, 60):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        return json_error("Les réglages d'affichage sont invalides.")
    with STORE_LOCK:
        state = load_state()
        state["settings"] = {"startHour": start_hour, "endHour": end_hour, "snapMinutes": snap}
        save_state(state)
    return jsonify(state)


@app.post("/api/events")
def create_event():
    payload = request.get_json(silent=True) or {}
    try:
        base = event_from_payload(payload)
        days = requested_days(payload, base["day"])
    except (TypeError, ValueError) as exc:
        return json_error(str(exc))

    with STORE_LOCK:
        state = load_state()
        created = []
        for day in days:
            event = {**base, "id": uuid.uuid4().hex, "day": day}
            if payload.get("behavior") == "replace":
                state["events"] = [old for old in state["events"] if not overlaps(old, event)]
            state["events"].append(event)
            created.append(event)
        state = validate_state(state)
        created = [next(item for item in state["events"] if item["id"] == event["id"]) for event in created]
        save_state(state)
    return jsonify({"events": created, "state": state}), 201


@app.put("/api/events/<event_id>")
def update_event(event_id: str):
    payload = request.get_json(silent=True) or {}
    with STORE_LOCK:
        state = load_state()
        existing = next((event for event in state["events"] if event["id"] == event_id), None)
        if not existing:
            return json_error("Cette activité n'existe plus.", 404)
        try:
            updated = event_from_payload(payload, existing)
            days = requested_days(payload, updated["day"])
        except (TypeError, ValueError) as exc:
            return json_error(str(exc))

        color_changed = updated["color"] != existing["color"]
        state["events"] = [event for event in state["events"] if event["id"] != event_id]
        changed = []
        for index, day in enumerate(days):
            event = {**updated, "id": event_id if index == 0 else uuid.uuid4().hex, "day": day}
            if payload.get("behavior") == "replace":
                state["events"] = [old for old in state["events"] if not overlaps(old, event)]
            state["events"].append(event)
            changed.append(event)
        if color_changed:
            for event in state["events"]:
                if event["title"] == updated["title"]:
                    event["color"] = updated["color"]
        state = validate_state(state)
        changed = [next(item for item in state["events"] if item["id"] == event["id"]) for event in changed]
        save_state(state)
    return jsonify({"events": changed, "state": state})


@app.delete("/api/events/<event_id>")
def delete_event(event_id: str):
    with STORE_LOCK:
        state = load_state()
        before = len(state["events"])
        state["events"] = [event for event in state["events"] if event["id"] != event_id]
        if len(state["events"]) == before:
            return json_error("Cette activité n'existe plus.", 404)
        save_state(state)
    return jsonify(state)


@app.post("/api/copy-day")
def copy_day():
    payload = request.get_json(silent=True) or {}
    try:
        source = int(payload["source"])
        targets = sorted({int(day) for day in payload["targets"]})
        if not (0 <= source <= 6) or not targets or any(day < 0 or day > 6 for day in targets):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        return json_error("Choisissez un jour source et au moins une destination.")

    with STORE_LOCK:
        state = load_state()
        source_events = [event for event in state["events"] if event["day"] == source]
        if payload.get("behavior", "replace") == "replace":
            state["events"] = [event for event in state["events"] if event["day"] not in targets]
        for target in targets:
            for original in source_events:
                state["events"].append({**deepcopy(original), "id": uuid.uuid4().hex, "day": target})
        state = validate_state(state)
        save_state(state)
    return jsonify(state)


@app.get("/export/json")
def export_json():
    content = json.dumps(load_state(), ensure_ascii=False, indent=2)
    return Response(content, mimetype="application/json", headers={
        "Content-Disposition": "attachment; filename=emploi-du-temps.json"
    })


@app.get("/export/csv")
def export_csv():
    state = load_state()
    output = io.StringIO()
    output.write("\ufeff")
    writer = csv.writer(output)
    writer.writerow(["Jour", "Heure de début", "Heure de fin", "Activité", "Notes", "Couleur"])
    for event in state["events"]:
        writer.writerow([DAYS[event["day"]], format_time(event["start"]), format_time(event["end"]), event["title"], event["notes"], event["color"]])
    return Response(output.getvalue(), mimetype="text/csv; charset=utf-8", headers={
        "Content-Disposition": "attachment; filename=emploi-du-temps.csv"
    })


def overlap_layout(events: list[dict]) -> list[tuple[dict, int, int]]:
    result = []
    events = sorted(events, key=lambda item: (item["start"], item["end"]))
    group: list[dict] = []
    group_end = -1

    def place(items: list[dict]):
        columns: list[int] = []
        assignments = []
        for item in items:
            column = next((i for i, end in enumerate(columns) if end <= item["start"]), len(columns))
            if column == len(columns):
                columns.append(item["end"])
            else:
                columns[column] = item["end"]
            assignments.append((item, column))
        count = max(1, len(columns))
        return [(item, column, count) for item, column in assignments]

    for event in events:
        if group and event["start"] >= group_end:
            result.extend(place(group))
            group = []
            group_end = -1
        group.append(event)
        group_end = max(group_end, event["end"])
    if group:
        result.extend(place(group))
    return result


@app.get("/export/png")
def export_png():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle

    state = load_state()
    settings = state["settings"]
    start, end = settings["startHour"] * 60, settings["endHour"] * 60
    fig, axis = plt.subplots(figsize=(15, 11), dpi=150)
    axis.set_xlim(0, 7)
    axis.set_ylim(end, start)
    axis.set_xticks([index + 0.5 for index in range(7)], DAYS)
    ticks = list(range(start, end + 1, 60))
    axis.set_yticks(ticks, [format_time(value) for value in ticks])
    axis.set_title("Emploi du temps", fontsize=19, fontweight="bold", pad=18)
    axis.grid(axis="y", color="#d8dce5", linewidth=0.7)
    axis.set_axisbelow(True)

    for day in range(7):
        day_events = [event for event in state["events"] if event["day"] == day and event["end"] > start and event["start"] < end]
        for event, column, count in overlap_layout(day_events):
            width = 0.92 / count
            x = day + 0.04 + column * width
            y = max(event["start"], start)
            height = min(event["end"], end) - y
            axis.add_patch(Rectangle((x, y), width - 0.015, height, facecolor=event["color"], edgecolor="white", linewidth=1.2, alpha=0.9))
            if height >= 25:
                label = event["title"] if height >= 45 else event["title"][:18]
                axis.text(x + (width - 0.015) / 2, y + height / 2, label, ha="center", va="center", fontsize=6.5, color="#172033", clip_on=True, wrap=True)

    for boundary in range(8):
        axis.axvline(boundary, color="#c6cbd6", linewidth=0.8)
    axis.spines[["top", "right", "left", "bottom"]].set_visible(False)
    fig.tight_layout()
    output = io.BytesIO()
    fig.savefig(output, format="png", bbox_inches="tight", facecolor="#f7f7fa")
    plt.close(fig)
    output.seek(0)
    return send_file(output, mimetype="image/png", as_attachment=True, download_name="emploi-du-temps.png")


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", port=5000)
