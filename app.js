import { episodes, series } from "./catalog.js";

const $ = id => document.getElementById(id);
const audio = $("audio");
const episodeById = new Map(episodes.map(episode => [episode.id, episode]));
const episodeIndex = new Map(episodes.map((episode, index) => [episode.id, index]));
const trackIds = episode => episode.tracks.length ? episode.tracks.map(track => track.id) : [episode.id + ":video"];
const historyIds = episodes.flatMap(trackIds);
const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const statusLabels = { unheard: "未聴", mid: "途中", done: "聴了" };
const storageKey = "kamamiku_player";
const pageSize = 24;

let state = cleanHistory(readStored(storageKey) ?? readStored("kamamiku_v1"));
let storageFailed = false;
let current = null;
let activeSeries = "all";
let activeFilter = "all";
let limit = pageSize;
let detailEpisode;
let toastTimer;
let installPrompt;
let scrubValue = null;
let sleepMode = "0";
let sleepDeadline = 0;
let sleepTimer;

function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function cleanHistory(raw) {
  const tracks = {};
  for (const id of historyIds) {
    const record = raw?.tracks?.[id];
    if (!record || typeof record !== "object") continue;
    const duration = Math.max(0, Number.isFinite(record.duration) ? record.duration : 0);
    const position = Math.max(0, Number.isFinite(record.pos) ? record.pos : 0);
    tracks[id] = { pos: duration ? Math.min(position, duration) : position, duration, done: record.done === true };
  }
  const lastEpisode = episodeById.get(raw?.last?.ep);
  const lastIndex = Number(raw?.last?.index);
  const last = Number.isInteger(lastIndex) && lastEpisode?.tracks[lastIndex] ? { ep: lastEpisode.id, index: lastIndex } : null;
  return { tracks, last, speed: speeds.includes(raw?.speed) ? raw.speed : 1, autoplay: raw?.autoplay !== false };
}

function writeHistory(update) {
  const persisted = readStored(storageKey);
  const previous = persisted && !storageFailed ? cleanHistory(persisted) : state;
  state = { ...previous, ...update, tracks: { ...previous.tracks, ...update.tracks } };
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    if (!storageFailed) toast("このブラウザでは履歴を保存できません。");
    storageFailed = true;
  }
}

function progress(track) {
  return state.tracks[track.id] ?? { pos: 0, duration: 0, done: false };
}

function statusOf(episode) {
  const records = trackIds(episode).map(id => state.tracks[id]);
  if (records.every(record => record?.done)) return "done";
  return records.some(record => record?.done || record?.pos >= 1) ? "mid" : "unheard";
}

function firstUnfinished(episode) {
  const index = episode.tracks.findIndex(track => !progress(track).done);
  return index < 0 ? 0 : index;
}

function savedPosition(track) {
  const record = progress(track);
  return record.done && record.duration && record.pos >= record.duration - 0.5 ? 0 : record.pos;
}

function nearbyEpisode(episode, direction) {
  let index = episodeIndex.get(episode.id) + direction;
  while (episodes[index] && !episodes[index].tracks.length) index += direction;
  return episodes[index] ?? null;
}

function neighboringTrack(episode, index, direction) {
  if (episode.tracks[index + direction]) return { episode, index: index + direction };
  const neighbor = nearbyEpisode(episode, direction);
  if (!neighbor) return null;
  return { episode: neighbor, index: direction > 0 ? firstUnfinished(neighbor) : neighbor.tracks.length - 1 };
}

function resumeChoice() {
  if (current?.requested) return { episode: current.episode, index: current.index, kind: "playing" };
  const last = episodeById.get(state.last?.ep);
  if (!last) return { episode: episodes[0], index: 0, kind: "first" };

  const index = state.last.index;
  if (!progress(last.tracks[index]).done || savedPosition(last.tracks[index]) >= 1) {
    return { episode: last, index, kind: "resume" };
  }
  if (statusOf(last) === "mid") return { episode: last, index: firstUnfinished(last), kind: "resume" };

  const next = nearbyEpisode(last, 1);
  return next ? { episode: next, index: firstUnfinished(next), kind: "next" } : { episode: last, index: 0, kind: "again" };
}

function formatTime(seconds) {
  const value = Math.floor(Math.max(0, seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function toast(message) {
  const node = $("toast");
  clearTimeout(toastTimer);
  node.textContent = message;
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 3400);
}

function escapeHtml(value) {
  const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, character => escapes[character]);
}

function icon(name) {
  return `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function setIcon(button, name) {
  const use = button.querySelector("use");
  const href = "#icon-" + name;
  if (use.getAttribute("href") !== href) use.setAttribute("href", href);
}

function setCover(element, show) {
  element.dataset.series = show.id;
  element.innerHTML = icon(show.icon);
}

function episodeLabel(episode) {
  return `${episode.show.short} · 第${episode.label}回`;
}

function renderSeries() {
  const grid = $("series-grid");
  const focusedSeries = grid.contains(document.activeElement) ? document.activeElement.dataset.series : null;
  grid.innerHTML = series.map(show => {
    const matching = episodes.filter(episode => episode.show === show);
    const heard = matching.filter(episode => statusOf(episode) === "done").length;
    const count = heard ? `${heard} / ${matching.length}回 聴了` : `${matching.length}回`;
    const bar = heard ? `<span class="series-progress" aria-hidden="true"><span style="width:${heard / matching.length * 100}%"></span></span>` : "";
    return `<button type="button" class="series-card" data-series="${show.id}" aria-pressed="${show.id === activeSeries}">
      <span class="cover" data-series="${show.id}" aria-hidden="true">${icon(show.icon)}</span>
      <span class="series-card-text"><strong>${show.short}</strong><small>${show.years} · ${count}</small></span>${bar}
    </button>`;
  }).join("");
  if (focusedSeries) grid.querySelector(`button[data-series="${focusedSeries}"]`)?.focus({ preventScroll: true });
  $("all-series").setAttribute("aria-pressed", String(activeSeries === "all"));
}

function searchText(value) {
  return value.normalize("NFKC").toLowerCase();
}

function renderEpisodes() {
  const list = $("episode-list");
  const focusedKey = list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  const tokens = searchText($("episode-search").value).trim().split(/\s+/).filter(Boolean);
  const visible = episodes.filter(episode => {
    if (activeSeries !== "all" && activeSeries !== episode.show.id) return false;
    if (activeFilter !== "all" && activeFilter !== statusOf(episode)) return false;
    const text = searchText(`${episode.title} ${episode.show.name} ${episodeLabel(episode)} #${episode.label} ${episode.number} ${episode.date}`);
    return tokens.every(token => text.includes(token));
  });
  if ($("episode-sort").value === "new") visible.reverse();
  $("episode-count").textContent = visible.length + "回";
  $("empty-list").hidden = visible.length > 0;
  $("more-episodes").hidden = visible.length <= limit;
  list.innerHTML = visible.slice(0, limit).map(episode => {
    const status = statusOf(episode);
    const selected = current?.episode === episode;
    const playing = selected && current.requested;
    const playable = episode.tracks.length > 0;
    const action = playable ? (playing ? "を一時停止" : "を再生") : "の視聴先を開く";
    const media = !playable ? " · 公式動画" : episode.tracks.length > 1 ? ` · ${episode.tracks.length}パート` : "";
    const title = escapeHtml(episode.title);
    return `<li class="episode${selected ? " is-current" : ""}">
      <button class="episode-main" type="button" data-play="${episode.id}" data-focus-key="play-${episode.id}" aria-label="${title}${action}">
        <span class="episode-play" aria-hidden="true">${icon(playable ? (playing ? "pause" : "play") : "video")}</span>
        <span class="episode-copy"><strong>${title}</strong><small>${episodeLabel(episode)} · ${episode.date.replaceAll("-", ".")}${media}</small></span>
        <span class="status ${status}">${statusLabels[status]}</span>
      </button>
      <button class="icon-button episode-detail" type="button" data-detail="${episode.id}" data-focus-key="detail-${episode.id}" aria-label="${title}の詳細" title="エピソードの詳細">${icon("dots")}</button>
    </li>`;
  }).join("");
  if (focusedKey) list.querySelector(`[data-focus-key="${focusedKey}"]`)?.focus({ preventScroll: true });
}

function renderHero() {
  const choice = resumeChoice();
  const heading = {
    first: ["はじめの一回", "最初の回を聴く"],
    resume: ["前回のつづき", "続きから聴く"],
    next: ["次のエピソード", "次の回を聴く"],
    again: ["最後のエピソード", "もう一度聴く"],
    playing: ["再生中のエピソード", "一時停止"],
  }[choice.kind];
  const position = savedPosition(choice.episode.tracks[choice.index]);
  const time = choice.kind === "resume" && position >= 1 ? ` · ${formatTime(position)}から` : "";
  $("hero-label").textContent = heading[0];
  $("hero-title").textContent = choice.episode.title;
  $("hero-meta").textContent = episodeLabel(choice.episode) + time;
  $("hero-play").querySelector("span").textContent = heading[1];
  setIcon($("hero-play"), choice.kind === "playing" ? "pause" : "play");
}

function renderArchive() {
  renderSeries();
  renderEpisodes();
  renderHero();
}

function activeAudio() {
  return current && audio.currentSrc === current.track.url;
}

function mediaPosition() {
  return activeAudio() && current.ready ? audio.currentTime : current?.start ?? 0;
}

function mediaDuration() {
  if (activeAudio() && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return current ? progress(current.track).duration : 0;
}

function savePosition({ ended = false, explicit = false } = {}) {
  if (!activeAudio() || !current.ready || (!current.started && !explicit)) return;
  const duration = mediaDuration();
  const pos = ended && duration ? duration : mediaPosition();
  if (!Number.isFinite(pos)) return;
  const was = statusOf(current.episode);
  const before = progress(current.track);
  writeHistory({
    tracks: { [current.track.id]: { pos, duration, done: ended || before.done } },
    last: { ep: current.episode.id, index: current.index },
  });
  current.lastWrite = Date.now();
  if (was !== statusOf(current.episode)) renderArchive();
  else if (!current.requested) renderHero();
}

function renderCurrentTrack() {
  $("mini-player").hidden = !current;
  document.body.classList.toggle("has-player", Boolean(current));
  if (!current) return;

  const { episode, index } = current;
  $("mini-title").textContent = episode.title;
  $("player-series").textContent = episodeLabel(episode);
  $("player-heading").textContent = episode.title;
  $("player-source").href = episode.article;
  setCover($("mini-cover"), episode.show);
  setCover($("player-cover"), episode.show);

  $("part-field").hidden = episode.tracks.length < 2;
  $("player-part").replaceChildren(...episode.tracks.map((track, partIndex) => new Option(track.name, partIndex)));
  $("player-part").value = String(index);
  for (const button of document.querySelectorAll("[data-move]")) {
    button.disabled = !neighboringTrack(episode, index, Number(button.dataset.move));
  }
  const next = neighboringTrack(episode, index, 1);
  const autoplay = next && (next.episode === episode || (state.autoplay && sleepMode !== "end"));
  $("up-next").hidden = !autoplay;
  $("up-next-title").textContent = autoplay ? (next.episode === episode ? episode.tracks[next.index].name : next.episode.title) : "";
  updateMediaMetadata();
  renderPlayback();
}

function renderPlayback() {
  if (!current) return;
  const duration = mediaDuration();
  const elapsed = scrubValue !== null && duration ? scrubValue * duration / 1000 : mediaPosition();
  const fraction = duration ? Math.min(1, Math.max(0, elapsed / duration)) : 0;
  const seekingAvailable = current.ready && duration > 0;
  $("elapsed").textContent = formatTime(elapsed);
  $("duration").textContent = duration ? formatTime(duration) : "–:––";
  $("seek").disabled = !seekingAvailable;
  $("seek").value = Math.round(fraction * 1000);
  $("seek").setAttribute("aria-valuetext", formatTime(elapsed));
  $("seek").style.setProperty("--progress", fraction * 100 + "%");
  $("mini-progress").style.setProperty("--progress", fraction * 100 + "%");
  $("mini-meta").textContent = current.notice || `${episodeLabel(current.episode)} · ${formatTime(elapsed)}`;
  const notice = $("player-notice");
  if (notice.textContent !== current.notice) notice.textContent = current.notice;
  notice.hidden = !current.notice;

  for (const button of document.querySelectorAll("[data-toggle-play]")) {
    setIcon(button, current.requested ? "pause" : "play");
    button.setAttribute("aria-label", current.requested ? "一時停止" : "再生");
  }
  for (const button of document.querySelectorAll("[data-skip]")) button.disabled = !seekingAvailable;
}

function loadTrack(episode, index, { play = true, position } = {}) {
  savePosition();
  const track = episode.tracks[index];
  current = {
    episode, index, track, start: position ?? savedPosition(track), ready: false,
    requested: false, started: false, finished: false, failed: false, retryOnline: false,
    notice: "", lastWrite: 0,
  };
  scrubValue = null;
  audio.src = track.url;
  audio.playbackRate = state.speed;
  audio.load();
  renderCurrentTrack();
  if (play) requestPlay();
  else renderArchive();
}

function selectEpisode(episode, index = firstUnfinished(episode)) {
  if (!episode.tracks.length) {
    openDetails(episode);
    return;
  }
  if (current?.episode === episode && current.index === index) togglePlayback();
  else loadTrack(episode, index);
}

function requestPlay() {
  if (!current) return;
  if (current.failed || current.finished || audio.ended) {
    const position = current.finished || audio.ended ? 0 : mediaPosition();
    loadTrack(current.episode, current.index, { position });
    return;
  }
  const request = current;
  request.requested = true;
  request.notice = request.ready ? "" : "読み込み中…";
  audio.play().catch(error => {
    if (current !== request || !request.requested || error.name === "AbortError") return;
    if (error.name === "NotAllowedError") {
      request.requested = false;
      request.notice = "再生ボタンを押すと始まります。";
      renderPlayback();
      renderArchive();
    } else reportAudioError();
  });
  renderPlayback();
  renderArchive();
}

function pausePlayback() {
  if (!current) return;
  current.requested = false;
  current.retryOnline = false;
  if (!current.failed) current.notice = "";
  audio.pause();
  savePosition();
  renderPlayback();
  renderArchive();
  updateMediaPosition();
}

function togglePlayback() {
  if (current?.requested) pausePlayback();
  else requestPlay();
}

function moveTrack(direction) {
  if (!current) return;
  const target = neighboringTrack(current.episode, current.index, direction);
  if (target) loadTrack(target.episode, target.index);
}

function seekTo(seconds) {
  if (!current?.ready || !activeAudio() || !Number.isFinite(audio.duration) || !Number.isFinite(seconds)) return;
  const target = Math.max(0, Math.min(seconds, audio.duration));
  try {
    audio.currentTime = target;
  } catch {
    return;
  }
  if (target < audio.duration - 0.1) current.finished = false;
  savePosition({ explicit: true });
  renderPlayback();
  updateMediaPosition();
}

function skip(seconds) {
  if (current?.ready) seekTo(mediaPosition() + seconds);
}

function reportAudioError() {
  if (!current || current.failed) return;
  const offline = navigator.onLine === false;
  savePosition();
  current.retryOnline = offline && current.requested;
  current.failed = true;
  current.requested = false;
  current.notice = offline ? "通信が切れました。接続後に再試行します。" : "再生できませんでした。再生ボタンで再試行できます。";
  if (!$("player-dialog").open) toast(current.notice);
  renderPlayback();
  renderArchive();
  updateMediaPosition();
}

function finishTrack() {
  if (!activeAudio() || !current.ready || current.finished) return;
  const { episode, index } = current;
  current.finished = true;
  current.requested = false;
  current.notice = "";
  savePosition({ ended: true, explicit: true });
  const next = neighboringTrack(episode, index, 1);
  const hasMoreParts = next?.episode === episode;
  const stopForTimer = (sleepMode === "end" && !hasMoreParts) || (sleepDeadline && Date.now() >= sleepDeadline);

  if (stopForTimer) {
    setSleep("0");
    toast("スリープタイマーで停止しました。");
  } else if (next && (hasMoreParts || state.autoplay)) {
    loadTrack(next.episode, next.index);
    return;
  } else if (!next) {
    toast("最後の回まで聴きました。");
  }

  renderCurrentTrack();
  renderArchive();
  updateMediaPosition();
}

function bindAudio() {
  audio.addEventListener("loadedmetadata", () => {
    if (!activeAudio()) return;
    const duration = mediaDuration();
    if (current.start && duration) {
      try {
        audio.currentTime = Math.min(current.start, Math.max(0, duration - 0.25));
      } catch {
        current.notice = "再生位置に移動できませんでした。";
      }
    }
    current.ready = true;
    audio.playbackRate = state.speed;
    renderPlayback();
    updateMediaPosition();
  });

  audio.addEventListener("playing", () => {
    if (!activeAudio() || audio.paused) return;
    current.notice = "";
    current.requested = true;
    current.started = true;
    savePosition();
    renderPlayback();
    renderArchive();
    updateMediaPosition();
  });

  audio.addEventListener("waiting", () => {
    if (!activeAudio() || !current.requested) return;
    current.notice = navigator.onLine === false ? "通信の復帰を待っています…" : "読み込み中…";
    renderPlayback();
  });

  audio.addEventListener("timeupdate", () => {
    if (!activeAudio() || !current.ready) return;
    if (sleepDeadline && Date.now() >= sleepDeadline) stopForSleep();
    renderPlayback();
    if (!audio.seeking && Date.now() - current.lastWrite > 3000) {
      savePosition();
      updateMediaPosition();
    }
  });

  audio.addEventListener("pause", () => {
    if (activeAudio() && current.ready && current.requested && audio.paused && !audio.ended) pausePlayback();
  });
  audio.addEventListener("ended", finishTrack);
  audio.addEventListener("error", () => {
    if (activeAudio()) reportAudioError();
  });
  window.addEventListener("online", () => {
    if (current?.retryOnline) loadTrack(current.episode, current.index, { position: mediaPosition() });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) savePosition();
    else if (sleepDeadline && Date.now() >= sleepDeadline) stopForSleep();
  });
  window.addEventListener("pagehide", () => savePosition());
}

function updateMediaMetadata() {
  if (!current || !("mediaSession" in navigator) || !("MediaMetadata" in window)) return;
  const { episode } = current;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: episode.title,
    artist: "かまど・みくのしん",
    album: episode.show.name,
    artwork: [{ src: new URL("./assets/app-icon-512.png", location.href).href, sizes: "512x512", type: "image/png" }],
  });
}

function updateMediaPosition() {
  if (!current || !("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  session.playbackState = current.requested && !audio.paused ? "playing" : "paused";
  const duration = mediaDuration();
  if (!session.setPositionState) return;
  if (!duration) session.setPositionState();
  else session.setPositionState({ duration, position: Math.min(duration, Math.max(0, mediaPosition())), playbackRate: state.speed });
}

function bindMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const actions = {
    play: requestPlay,
    pause: pausePlayback,
    seekbackward: event => skip(-(event.seekOffset || 10)),
    seekforward: event => skip(event.seekOffset || 30),
    seekto: event => seekTo(event.seekTime),
    nexttrack: () => moveTrack(1),
    previoustrack: () => moveTrack(-1),
  };
  for (const [name, handler] of Object.entries(actions)) {
    try {
      navigator.mediaSession.setActionHandler(name, handler);
    } catch {
      // Available actions vary with the browser and platform.
    }
  }
}

function setSleep(value) {
  clearTimeout(sleepTimer);
  sleepMode = value;
  sleepDeadline = Number(value) > 0 ? Date.now() + Number(value) * 60_000 : 0;
  $("sleep").value = value;
  if (sleepDeadline) sleepTimer = setTimeout(stopForSleep, sleepDeadline - Date.now());
  if (current) renderCurrentTrack();
}

function stopForSleep() {
  setSleep("0");
  pausePlayback();
  toast("スリープタイマーで停止しました。");
}

function openDetails(episode) {
  detailEpisode = episode;
  $("detail-title").textContent = episode.title;
  $("detail-meta").textContent = episodeLabel(episode) + " · " + episode.date.replaceAll("-", ".");
  $("detail-source").href = episode.article;
  $("detail-video").hidden = episode.tracks.length > 0;
  $("detail-parts").hidden = !episode.tracks.length;
  $("detail-parts").replaceChildren(...episode.tracks.map((track, index) => {
    const record = progress(track);
    const label = record.done ? "聴了" : record.pos >= 1 ? formatTime(record.pos) + "から" : "再生";
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `${icon("play")}<span>${escapeHtml(track.name)}</span><small>${label}</small>`;
    button.addEventListener("click", () => {
      $("episode-dialog").close();
      selectEpisode(episode, index);
    });
    return button;
  }));
  $("mark-listened").textContent = statusOf(episode) === "done" ? "未聴に戻す" : "聴了にする";
  $("episode-dialog").showModal();
}

function markListened() {
  const episode = detailEpisode;
  if (!episode) return;
  savePosition();
  const done = statusOf(episode) !== "done";
  const tracks = Object.fromEntries(trackIds(episode).map(id => {
    const duration = state.tracks[id]?.duration ?? 0;
    return [id, { done, pos: done ? duration : 0, duration }];
  }));
  const last = !done && state.last?.ep === episode.id ? null : state.last;
  writeHistory({ tracks, last });
  $("episode-dialog").close();

  if (!done && current?.episode === episode) {
    audio.pause();
    current = null;
    loadTrack(episode, 0, { play: false, position: 0 });
  } else renderArchive();
  toast(done ? "聴了にしました。" : "未聴に戻しました。");
}

function exportHistory() {
  savePosition();
  const data = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), state }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "kamamiku-history.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function importHistory() {
  const input = $("history-file");
  const file = input.files[0];
  if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error("History file is too large.");
    const data = JSON.parse(await file.text());
    if (data?.version !== 1 || !data.state?.tracks || Array.isArray(data.state.tracks) || typeof data.state.tracks !== "object") {
      throw new Error("Invalid history file.");
    }
    pausePlayback();
    current = null;
    const imported = cleanHistory(data.state);
    writeHistory({ tracks: imported.tracks, last: imported.last ?? state.last });
    const choice = resumeChoice();
    if (choice.kind === "resume") loadTrack(choice.episode, choice.index, { play: false });
    else {
      audio.removeAttribute("src");
      audio.load();
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
      renderCurrentTrack();
      renderArchive();
    }
    $("settings-dialog").close();
    toast("履歴を読み込みました。");
  } catch {
    $("settings-dialog").close();
    toast("履歴ファイルを読み込めませんでした。");
  } finally {
    input.value = "";
  }
}

function bindUi() {
  const updateList = () => {
    limit = pageSize;
    renderEpisodes();
  };

  function chooseSeries(id) {
    activeSeries = id;
    renderSeries();
    updateList();
  }

  $("all-series").addEventListener("click", () => chooseSeries("all"));
  $("series-grid").addEventListener("click", event => {
    const button = event.target.closest("button[data-series]");
    if (button) chooseSeries(activeSeries === button.dataset.series ? "all" : button.dataset.series);
  });
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      for (const other of document.querySelectorAll("[data-filter]")) other.setAttribute("aria-pressed", String(other === button));
      updateList();
    });
  }
  $("episode-search").addEventListener("input", updateList);
  $("episode-sort").addEventListener("change", updateList);
  $("more-episodes").addEventListener("click", () => {
    limit += pageSize;
    renderEpisodes();
  });
  $("episode-list").addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button?.dataset.play) {
      const episode = episodeById.get(button.dataset.play);
      if (current?.episode === episode) togglePlayback();
      else selectEpisode(episode);
    } else if (button?.dataset.detail) openDetails(episodeById.get(button.dataset.detail));
  });

  $("hero-play").addEventListener("click", () => {
    const choice = resumeChoice();
    selectEpisode(choice.episode, choice.index);
  });
  $("open-player").addEventListener("click", () => $("player-dialog").showModal());
  $("player-part").addEventListener("change", event => loadTrack(current.episode, Number(event.target.value)));
  for (const button of document.querySelectorAll("[data-toggle-play]")) button.addEventListener("click", togglePlayback);
  for (const button of document.querySelectorAll("[data-skip]")) button.addEventListener("click", () => skip(Number(button.dataset.skip)));
  for (const button of document.querySelectorAll("[data-move]")) button.addEventListener("click", () => moveTrack(Number(button.dataset.move)));
  $("seek").addEventListener("input", event => {
    scrubValue = Number(event.target.value);
    renderPlayback();
  });
  $("seek").addEventListener("change", event => {
    const value = Number(event.target.value);
    scrubValue = null;
    seekTo(value * mediaDuration() / 1000);
  });
  $("seek").addEventListener("pointercancel", () => {
    scrubValue = null;
    renderPlayback();
  });
  $("speed").replaceChildren(...speeds.map(rate => new Option(rate + "×", rate)));
  $("speed").value = String(state.speed);
  $("speed").addEventListener("change", event => {
    writeHistory({ speed: Number(event.target.value) });
    audio.playbackRate = state.speed;
    updateMediaPosition();
  });
  $("sleep").addEventListener("change", event => setSleep(event.target.value));

  $("settings-button").addEventListener("click", () => {
    $("autoplay").checked = state.autoplay;
    $("settings-dialog").showModal();
  });
  $("autoplay").addEventListener("change", event => {
    writeHistory({ autoplay: event.target.checked });
    if (current) renderCurrentTrack();
  });
  $("export-history").addEventListener("click", exportHistory);
  $("import-history").addEventListener("click", () => $("history-file").click());
  $("history-file").addEventListener("change", importHistory);
  $("mark-listened").addEventListener("click", markListened);

  window.addEventListener("storage", event => {
    if (event.key !== storageKey || !event.newValue) return;
    const incoming = readStored(storageKey);
    if (!incoming) return;
    state = cleanHistory(incoming);
    audio.playbackRate = state.speed;
    $("speed").value = String(state.speed);
    $("autoplay").checked = state.autoplay;
    renderArchive();
    if (current) renderCurrentTrack();
  });

  $("install-button").hidden = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
  });
  window.addEventListener("appinstalled", () => {
    $("install-button").hidden = true;
    installPrompt = null;
  });
  $("install-button").addEventListener("click", async () => {
    if (!installPrompt) {
      $("install-dialog").showModal();
      return;
    }
    const prompt = installPrompt;
    installPrompt = null;
    try {
      await prompt.prompt();
    } catch {
      $("install-dialog").showModal();
    }
  });
}

bindUi();
bindAudio();
bindMediaSession();
const previous = resumeChoice();
if (previous.kind === "resume") loadTrack(previous.episode, previous.index, { play: false });
else renderArchive();
$("hero-play").disabled = false;

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").catch(error => console.warn("Service worker registration failed.", error));
}
