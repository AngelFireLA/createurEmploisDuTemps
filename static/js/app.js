const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const COLORS = ["#6C8CF5", "#F29A68", "#58B89C", "#A77BD8", "#E16E83", "#D7A72F", "#4BA3C7", "#7B9B57", "#C878B4", "#5978B9"];

let schedule = { settings: { startHour: 7, endHour: 24, snapMinutes: 15 }, events: [] };
let dragged = false;
let toastTimer;
let resizeTimer;
let minuteHeight = .72;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function minutesToTime(minutes) {
  if (minutes === 1440) return "24:00";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function minutesToInputTime(minutes) {
  return minutesToTime(Math.min(1439, minutes));
}

function hslToHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = hue / 60;
  const intermediate = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] = section < 1 ? [chroma, intermediate, 0]
    : section < 2 ? [intermediate, chroma, 0]
      : section < 3 ? [0, chroma, intermediate]
        : section < 4 ? [0, intermediate, chroma]
          : section < 5 ? [intermediate, 0, chroma]
            : [chroma, 0, intermediate];
  const offset = l - chroma / 2;
  return `#${[red, green, blue].map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function colorChannels(color) {
  return [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
}

function colorDistance(first, second) {
  const [r1, g1, b1] = colorChannels(first);
  const [r2, g2, b2] = colorChannels(second);
  const redMean = (r1 + r2) / 2;
  return (2 + redMean / 256) * (r1 - r2) ** 2
    + 4 * (g1 - g2) ** 2
    + (2 + (255 - redMean) / 256) * (b1 - b2) ** 2;
}

function chooseDefaultColor() {
  const used = [...new Set(schedule.events.map((event) => event.color.toUpperCase()))];
  if (!used.length) return COLORS[0];

  const generated = [];
  for (let hue = 0; hue < 360; hue += 15) {
    generated.push(hslToHex(hue, 58, 58), hslToHex(hue, 68, 67));
  }
  const candidates = [...new Set([...COLORS.map((color) => color.toUpperCase()), ...generated])];
  const unused = candidates.filter((candidate) => !used.includes(candidate));
  return unused.reduce((best, candidate) => {
    const distance = Math.min(...used.map((color) => colorDistance(candidate, color)));
    return distance > best.distance ? { color: candidate, distance } : best;
  }, { color: COLORS[0], distance: -1 }).color;
}

function timeToMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function snap(value) {
  const precision = schedule.settings.snapMinutes;
  return Math.round(value / precision) * precision;
}

function todayIndex() {
  return (new Date().getDay() + 6) % 7;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("is-error", error);
  element.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("is-visible"), 2600);
}

function setSaveStatus(label) {
  const status = $("#saveStatus");
  if (status) status.textContent = label;
}

async function api(url, options = {}) {
  setSaveStatus(options.method ? "Enregistrement…" : "Chargement…");
  try {
    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Une erreur est survenue.");
    setSaveStatus("À jour");
    return data;
  } catch (error) {
    setSaveStatus("Erreur");
    toast(error.message, true);
    throw error;
  }
}

function layoutEvents(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
  const laidOut = [];
  let group = [];
  let groupEnd = -1;

  const placeGroup = (items) => {
    const columnEnds = [];
    const placements = items.map((event) => {
      let column = columnEnds.findIndex((end) => end <= event.start);
      if (column < 0) column = columnEnds.length;
      columnEnds[column] = event.end;
      return { event, column };
    });
    const columns = Math.max(1, columnEnds.length);
    placements.forEach((entry) => laidOut.push({ ...entry, columns }));
  };

  sorted.forEach((event) => {
    if (group.length && event.start >= groupEnd) {
      placeGroup(group);
      group = [];
      groupEnd = -1;
    }
    group.push(event);
    groupEnd = Math.max(groupEnd, event.end);
  });
  if (group.length) placeGroup(group);
  return laidOut;
}

function renderHeader() {
  $("#weekHead").innerHTML = DAYS.map((day, index) => `
    <div class="day-head ${index === todayIndex() ? "is-today" : ""}">
      <b>${day}</b>
    </div>
  `).join("");
}

function eventElement(entry, displayStart, displayEnd) {
  const { event, column, columns } = entry;
  const top = (Math.max(event.start, displayStart) - displayStart) * minuteHeight;
  const height = (Math.min(event.end, displayEnd) - Math.max(event.start, displayStart)) * minuteHeight;
  const gap = columns > 1 ? 1 : 2;
  const element = document.createElement("div");
  element.className = `event${height < 38 ? " compact" : ""}${height < 23 ? " tiny" : ""}${height < 12 ? " micro" : ""}`;
  element.dataset.id = event.id;
  element.tabIndex = 0;
  element.title = `${event.title} — ${minutesToTime(event.start)} à ${minutesToTime(event.end)}`;
  element.setAttribute("role", "button");
  element.setAttribute("aria-label", `${event.title}, ${minutesToTime(event.start)} à ${minutesToTime(event.end)}, ${DAYS[event.day]}`);
  element.style.cssText = `--event-color:${event.color};top:${top}px;height:${Math.max(height, 8)}px;left:calc(${column * (100 / columns)}% + ${gap / 2}px);width:calc(${100 / columns}% - ${gap}px)`;
  element.innerHTML = `
    <span class="event-title"></span>
    <span class="event-time">${minutesToTime(event.start)} — ${minutesToTime(event.end)}</span>
    ${event.notes ? '<span class="event-notes"></span>' : ""}
    <span class="resize-handle" aria-hidden="true"></span>
  `;
  $(".event-title", element).textContent = event.title;
  if (event.notes) $(".event-notes", element).textContent = event.notes;
  element.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    if (!dragged) openEventDialog(event);
  });
  element.addEventListener("keydown", (keyEvent) => {
    if (keyEvent.key === "Enter" || keyEvent.key === " ") openEventDialog(event);
  });
  bindDrag(element, event);
  bindResize($(".resize-handle", element), element, event);
  return element;
}

function renderCalendar() {
  renderHeader();
  const { startHour, endHour } = schedule.settings;
  const displayStart = startHour * 60;
  const displayEnd = endHour * 60;
  const reservedHeight = window.innerWidth <= 600 ? 145 : 105;
  minuteHeight = Math.min(.78, Math.max(.55, (window.innerHeight - reservedHeight) / (displayEnd - displayStart)));
  document.documentElement.style.setProperty("--minute-height", `${minuteHeight}px`);
  document.documentElement.style.setProperty("--hour-height", `${minuteHeight * 60}px`);
  const height = (displayEnd - displayStart) * minuteHeight;
  const body = $("#calendarBody");
  body.style.setProperty("--calendar-height", `${height}px`);
  body.innerHTML = '<div class="time-axis"></div><div class="days-layer"></div>';
  const axis = $(".time-axis", body);
  for (let minute = displayStart; minute <= displayEnd; minute += 60) {
    const label = document.createElement("span");
    label.className = "time-label";
    label.style.top = `${(minute - displayStart) * minuteHeight}px`;
    label.textContent = minutesToTime(minute);
    axis.append(label);
  }

  const daysLayer = $(".days-layer", body);
  DAYS.forEach((day, index) => {
    const column = document.createElement("div");
    column.className = "day-column";
    column.dataset.day = index;
    column.setAttribute("aria-label", day);
    column.addEventListener("click", (event) => {
      if (event.target !== column) return;
      const rect = column.getBoundingClientRect();
      const start = Math.min(displayEnd - 30, Math.max(displayStart, snap(displayStart + (event.clientY - rect.top) / minuteHeight)));
      openEventDialog(null, index, start);
    });
    const events = schedule.events.filter((item) => item.day === index && item.end > displayStart && item.start < displayEnd);
    layoutEvents(events).forEach((entry) => column.append(eventElement(entry, displayStart, displayEnd)));
    daysLayer.append(column);
  });
}

function selectedValues(container) {
  return $$('input[type="checkbox"]:checked', container).map((input) => Number(input.value));
}

function setSelectedDays(container, days) {
  $$('input[type="checkbox"]', container).forEach((input) => { input.checked = days.includes(Number(input.value)); });
}

function findFirstAvailableStart(days, duration = 60) {
  const displayStart = schedule.settings.startHour * 60;
  const displayEnd = schedule.settings.endHour * 60;
  const precision = schedule.settings.snapMinutes;
  for (let candidate = displayStart; candidate + duration <= displayEnd; candidate += precision) {
    const candidateEnd = candidate + duration;
    const occupied = schedule.events.some((event) => days.includes(event.day)
      && event.start < candidateEnd && event.end > candidate);
    if (!occupied) return candidate;
  }
  return Math.max(displayStart, displayEnd - duration);
}

function openEventDialog(event = null, day = todayIndex(), start = null, allDays = false) {
  const dialog = $("#eventDialog");
  const current = new Date();
  const nowMinutes = current.getHours() * 60 + current.getMinutes();
  const fallbackStart = Math.max(schedule.settings.startHour * 60, Math.min(schedule.settings.endHour * 60 - 60, snap(nowMinutes)));
  const selectedDays = event ? [event.day] : allDays ? DAYS.map((_, index) => index) : [day];
  const eventStart = event?.start ?? start ?? (allDays ? findFirstAvailableStart(selectedDays) : fallbackStart);
  $("#eventId").value = event?.id || "";
  $("#eventTitle").value = event?.title || "";
  $("#eventStart").value = minutesToInputTime(eventStart);
  $("#eventEnd").value = minutesToInputTime(event?.end ?? Math.min(eventStart + 60, 1439));
  $("#eventNotes").value = event?.notes || "";
  $("#eventColor").value = event?.color || chooseDefaultColor();
  setSelectedDays($("#eventDays"), selectedDays);
  $$('input[name="behavior"]').forEach((input) => { input.checked = input.value === "overlap"; });
  $("#eventEyebrow").textContent = event ? "Modifier l'activité" : "Nouvelle activité";
  $("#eventDialogTitle").textContent = event ? event.title : "Ajouter à la semaine";
  $("#saveEventButton").textContent = event ? "Enregistrer" : "Ajouter";
  $("#deleteButton").classList.toggle("is-hidden", !event);
  syncColorChoices();
  dialog.showModal();
  setTimeout(() => $("#eventTitle").focus(), 60);
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog?.open) dialog.close();
}

function syncColorChoices() {
  const selected = $("#eventColor").value.toUpperCase();
  $$(".color-choice").forEach((choice) => choice.classList.toggle("is-selected", choice.dataset.color === selected));
}

async function submitEvent(event) {
  event.preventDefault();
  const id = $("#eventId").value;
  const days = selectedValues($("#eventDays"));
  if (!days.length) return toast("Sélectionnez au moins un jour.", true);
  const payload = {
    title: $("#eventTitle").value,
    start: $("#eventStart").value,
    end: $("#eventEnd").value,
    notes: $("#eventNotes").value,
    color: $("#eventColor").value,
    days,
    behavior: $('input[name="behavior"]:checked').value,
  };
  try {
    const data = await api(id ? `/api/events/${id}` : "/api/events", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
    schedule = data.state;
    closeDialog("eventDialog");
    renderCalendar();
    toast(id ? "Activité mise à jour." : days.length > 1 ? `Activité ajoutée sur ${days.length} jours.` : "Activité ajoutée.");
  } catch (_) { /* api already reports the error */ }
}

async function deleteCurrentEvent() {
  const id = $("#eventId").value;
  if (!id || !window.confirm("Supprimer cette activité ?")) return;
  try {
    schedule = await api(`/api/events/${id}`, { method: "DELETE" });
    closeDialog("eventDialog");
    renderCalendar();
    toast("Activité supprimée.");
  } catch (_) { /* reported */ }
}

async function submitCopy(event) {
  event.preventDefault();
  const source = Number($("#copySource").value);
  const targets = selectedValues($("#copyTargets")).filter((day) => day !== source);
  if (!targets.length) return toast("Choisissez au moins un autre jour.", true);
  const behavior = $('input[name="copyBehavior"]:checked').value;
  try {
    schedule = await api("/api/copy-day", { method: "POST", body: JSON.stringify({ source, targets, behavior }) });
    closeDialog("copyDialog");
    renderCalendar();
    toast(`${DAYS[source]} copié vers ${targets.map((day) => DAYS[day]).join(", ")}.`);
  } catch (_) { /* reported */ }
}

function updateCopyTargets() {
  const source = Number($("#copySource").value);
  $$('#copyTargets input[type="checkbox"]').forEach((input) => {
    input.disabled = Number(input.value) === source;
    if (input.disabled) input.checked = false;
    input.nextElementSibling.style.opacity = input.disabled ? ".35" : "1";
  });
}

async function submitSettings(event) {
  event.preventDefault();
  const payload = {
    startHour: Number($("#startHour").value),
    endHour: Number($("#endHour").value),
    snapMinutes: Number($("#snapMinutes").value),
  };
  try {
    schedule = await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
    closeDialog("settingsDialog");
    renderCalendar();
    toast("Affichage mis à jour.");
  } catch (_) { /* reported */ }
}

function bindDrag(element, event) {
  element.addEventListener("pointerdown", (pointerEvent) => {
    if (pointerEvent.button !== 0 || pointerEvent.target.classList.contains("resize-handle")) return;
    const startX = pointerEvent.clientX;
    const startY = pointerEvent.clientY;
    const originalDay = event.day;
    let nextDay = originalDay;
    let nextStart = event.start;
    let moved = false;
    element.setPointerCapture(pointerEvent.pointerId);

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      dragged = true;
      element.classList.add("is-dragging");
      const dayWidth = $(".days-layer").getBoundingClientRect().width / 7;
      nextDay = Math.max(0, Math.min(6, originalDay + Math.round(dx / dayWidth)));
      const duration = event.end - event.start;
      nextStart = Math.max(0, Math.min(1440 - duration, event.start + snap(dy / minuteHeight)));
      element.style.transform = `translate(${(nextDay - originalDay) * dayWidth}px, ${(nextStart - event.start) * minuteHeight}px)`;
      $(".event-time", element).textContent = `${minutesToTime(nextStart)} — ${minutesToTime(nextStart + duration)}`;
    };

    const onUp = async () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
      if (!moved) return;
      const duration = event.end - event.start;
      try {
        const data = await api(`/api/events/${event.id}`, { method: "PUT", body: JSON.stringify({ day: nextDay, days: [nextDay], start: nextStart, end: nextStart + duration }) });
        schedule = data.state;
        renderCalendar();
        toast(`Déplacé à ${DAYS[nextDay]}, ${minutesToTime(nextStart)}.`);
      } catch (_) { renderCalendar(); }
      setTimeout(() => { dragged = false; }, 0);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);
  });
}

function bindResize(handle, element, event) {
  handle.addEventListener("pointerdown", (pointerEvent) => {
    pointerEvent.stopPropagation();
    const startY = pointerEvent.clientY;
    let nextEnd = event.end;
    let moved = false;
    handle.setPointerCapture(pointerEvent.pointerId);

    const onMove = (moveEvent) => {
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.abs(dy) < 4) return;
      moved = true;
      dragged = true;
      nextEnd = Math.max(event.start + schedule.settings.snapMinutes, Math.min(1440, event.end + snap(dy / minuteHeight)));
      element.classList.add("is-dragging");
      element.style.height = `${Math.max(17, (nextEnd - event.start) * minuteHeight)}px`;
      $(".event-time", element).textContent = `${minutesToTime(event.start)} — ${minutesToTime(nextEnd)}`;
    };
    const onUp = async () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      if (!moved) return;
      try {
        const data = await api(`/api/events/${event.id}`, { method: "PUT", body: JSON.stringify({ start: event.start, end: nextEnd, days: [event.day] }) });
        schedule = data.state;
        renderCalendar();
        toast(`Durée ajustée jusqu'à ${minutesToTime(nextEnd)}.`);
      } catch (_) { renderCalendar(); }
      setTimeout(() => { dragged = false; }, 0);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

function initializeControls() {
  COLORS.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-choice";
    button.dataset.color = color;
    button.style.setProperty("--choice", color);
    button.setAttribute("aria-label", `Choisir la couleur ${color}`);
    button.addEventListener("click", () => { $("#eventColor").value = color; syncColorChoices(); });
    $("#colorChoices").append(button);
  });
  for (let hour = 0; hour <= 23; hour += 1) $("#startHour").add(new Option(`${String(hour).padStart(2, "0")}:00`, hour));
  for (let hour = 1; hour <= 24; hour += 1) $("#endHour").add(new Option(`${String(hour).padStart(2, "0")}:00`, hour));

  $("#eventForm").addEventListener("submit", submitEvent);
  $("#copyForm").addEventListener("submit", submitCopy);
  $("#settingsForm").addEventListener("submit", submitSettings);
  $("#deleteButton").addEventListener("click", deleteCurrentEvent);
  $("#eventColor").addEventListener("input", syncColorChoices);
  $("#copySource").addEventListener("change", updateCopyTargets);
  $("#printButton").addEventListener("click", () => window.print());
  $("#addButton").addEventListener("click", () => openEventDialog(null, todayIndex(), null, true));
  $("#copyDayButton").addEventListener("click", () => { updateCopyTargets(); $("#copyDialog").showModal(); });
  $("#settingsButton").addEventListener("click", () => {
    $("#startHour").value = schedule.settings.startHour;
    $("#endHour").value = schedule.settings.endHour;
    $("#snapMinutes").value = schedule.settings.snapMinutes;
    $("#settingsDialog").showModal();
  });
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => closeDialog(button.dataset.close)));
  $$('dialog').forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  }));
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCalendar, 120);
  });
}

async function initialize() {
  initializeControls();
  try {
    schedule = await api("/api/schedule");
    renderCalendar();
  } catch (_) { /* page remains usable enough to show the error */ }
}

initialize();
