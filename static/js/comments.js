/* ══════════════════════════════════════════════════════════════════════
   msc = "My Stream Comments" — standalone, reusable live comment/chat
   component. Talks to /api/room/<room>/... on the backend (real MongoDB
   storage — see main.py). Depends only on:
     - window.MSC_ROOM   (string, set by the host page before this loads)
     - a handful of DOM ids defined in the markup this ships with
   Nothing here reaches into the video player's own code/state, so it can
   be lifted into another page with the matching markup + CSS.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
    "use strict";

    var ROOM = window.MSC_ROOM || "default";
    var API_BASE = "/api/room/" + encodeURIComponent(ROOM);

    // ─────────────────────────── DOM refs ───────────────────────────
    var statViewers = document.getElementById("statViewers");
    var toggleBox = document.getElementById("commentToggleBox");
    var toggleLabel = document.getElementById("commentToggleLabel");
    var panel = document.getElementById("mscPanel");
    var viewerSub = document.getElementById("mscViewerSub");
    var feed = document.getElementById("mscFeed");
    var emptyState = document.getElementById("mscEmpty");
    var settingsBtn = document.getElementById("mscSettingsBtn");

    var emojiBtn = document.getElementById("mscEmojiBtn");
    var emojiPicker = document.getElementById("mscEmojiPicker");
    var imageBtn = document.getElementById("mscImageBtn");
    var imageInput = document.getElementById("mscImageInput");
    var imagePreview = document.getElementById("mscImagePreview");
    var imagePreviewImg = document.getElementById("mscImagePreviewImg");
    var imageRemove = document.getElementById("mscImageRemove");
    var textarea = document.getElementById("mscTextarea");
    var sendBtn = document.getElementById("mscSendBtn");

    var profileOverlay = document.getElementById("mscProfileOverlay");
    var avatarPick = document.getElementById("mscAvatarPick");
    var avatarPickImg = document.getElementById("mscAvatarPickImg");
    var avatarPickIcon = document.getElementById("mscAvatarPickIcon");
    var avatarInput = document.getElementById("mscAvatarInput");
    var nameInput = document.getElementById("mscNameInput");
    var nameCounter = document.getElementById("mscNameCounter");
    var profileCancel = document.getElementById("mscProfileCancel");
    var profileSave = document.getElementById("mscProfileSave");

    var toastEl = document.getElementById("mscToast");

    var MAX_NAME_LEN = 15;
    var MAX_AVATAR_INPUT_BYTES = 10 * 1024 * 1024; // 10MB accepted from picker, then compressed
    var MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;

    // ─────────────────────────── Toast ───────────────────────────
    var toastTimer = null;
    function toast(msg) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
    }

    // ─────────────────────────── Profile (local persistence) ───────────────────────────
    var PROFILE_KEY = "msc_profile_v1";
    var profile = null; // { name, avatar, client_id }

    function loadProfile() {
        try {
            var raw = localStorage.getItem(PROFILE_KEY);
            if (!raw) return null;
            var p = JSON.parse(raw);
            if (!p || typeof p !== "object" || !p.client_id || !p.name) return null;
            return p;
        } catch (e) {
            return null; // corrupted local data — treat as no profile, don't crash
        }
    }

    function saveProfile(p) {
        profile = p;
        try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {}
    }

    function genClientId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    profile = loadProfile();

    // ─────────────────────────── Image compression ───────────────────────────
    // Resizes + re-encodes client-side so localStorage/Mongo never sees huge blobs.
    function compressImage(file, maxDim, quality) {
        return new Promise(function (resolve, reject) {
            if (!file || file.type.indexOf("image/") !== 0) {
                reject(new Error("Sirf image files allowed hain."));
                return;
            }
            var reader = new FileReader();
            reader.onerror = function () { reject(new Error("Image read nahi ho payi.")); };
            reader.onload = function () {
                var img = new Image();
                img.onerror = function () { reject(new Error("Image corrupt/invalid hai.")); };
                img.onload = function () {
                    var w = img.width, h = img.height;
                    var scale = Math.min(1, maxDim / Math.max(w, h));
                    var cw = Math.max(1, Math.round(w * scale));
                    var ch = Math.max(1, Math.round(h * scale));
                    var canvas = document.createElement("canvas");
                    canvas.width = cw; canvas.height = ch;
                    var ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0, cw, ch);
                    try {
                        resolve(canvas.toDataURL("image/jpeg", quality));
                    } catch (e) {
                        reject(new Error("Image process nahi ho payi."));
                    }
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    // ─────────────────────────── API client ───────────────────────────
    function apiGet(url) {
        return fetch(url).then(function (r) { return r.json(); });
    }
    function apiPost(url, body) {
        return fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); });
    }
    function apiDelete(url, body) {
        return fetch(url, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); });
    }

    // ─────────────────────────── Viewer heartbeat ("User's" count) ───────────────────────────
    function ensureAnonClientId() {
        // Even without a profile yet, we need a stable id for the heartbeat.
        var key = "msc_anon_id_v1";
        try {
            var id = localStorage.getItem(key);
            if (!id) { id = genClientId(); localStorage.setItem(key, id); }
            return id;
        } catch (e) { return genClientId(); }
    }
    var HEARTBEAT_CLIENT_ID = (profile && profile.client_id) || ensureAnonClientId();

    function heartbeat() {
        apiPost(API_BASE + "/heartbeat", { client_id: HEARTBEAT_CLIENT_ID }).then(function (res) {
            if (res.ok && res.data && typeof res.data.count === "number") {
                if (statViewers) statViewers.textContent = String(res.data.count);
                if (viewerSub) viewerSub.textContent = res.data.count + " watching";
            }
        }).catch(function () {});
    }
    heartbeat();
    setInterval(heartbeat, 15000);

    // ─────────────────────────── Feed rendering ───────────────────────────
    var lastCreatedAt = null;
    var renderedIds = {};

    function escapeHtml(s) {
        var d = document.createElement("div");
        d.textContent = s == null ? "" : String(s);
        return d.innerHTML;
    }

    function isNearBottom() {
        return (feed.scrollHeight - feed.scrollTop - feed.clientHeight) < 90;
    }

    function timeLabel(iso) {
        try {
            var d = new Date(iso);
            var h = d.getHours(), m = d.getMinutes();
            var ampm = h >= 12 ? "PM" : "AM";
            h = h % 12; if (h === 0) h = 12;
            return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
        } catch (e) { return ""; }
    }

    function openLightbox(src) {
        var box = document.createElement("div");
        box.className = "msc-lightbox";
        var img = document.createElement("img");
        img.src = src;
        box.appendChild(img);
        box.addEventListener("click", function () { box.remove(); });
        document.body.appendChild(box);
    }

    var armedMsgEl = null;
    var pressTimer = null;

    function renderMessage(c) {
        if (renderedIds[c._id]) return;
        renderedIds[c._id] = true;

        var isOwn = profile && c.client_id === profile.client_id;

        var wrap = document.createElement("div");
        wrap.className = "msc-msg" + (isOwn ? " msc-own" : "");
        wrap.dataset.id = c._id;

        var avatar = document.createElement("div");
        avatar.className = "msc-msg-avatar";
        if (c.avatar) {
            var img = document.createElement("img");
            img.src = c.avatar; img.alt = "";
            avatar.appendChild(img);
        } else {
            avatar.textContent = (c.name || "?").trim().charAt(0).toUpperCase();
        }

        var body = document.createElement("div");
        body.className = "msc-msg-body";

        var head = document.createElement("div");
        head.className = "msc-msg-head";
        var nameEl = document.createElement("span");
        nameEl.className = "msc-msg-name";
        nameEl.textContent = c.name || "Guest";
        var timeEl = document.createElement("span");
        timeEl.className = "msc-msg-time";
        timeEl.textContent = timeLabel(c.created_at);
        head.appendChild(nameEl); head.appendChild(timeEl);

        var bubble = document.createElement("div");
        bubble.className = "msc-msg-bubble";
        if (c.text) {
            var p = document.createElement("p");
            p.textContent = c.text; // textContent only — never innerHTML for user text
            bubble.appendChild(p);
        }
        if (c.image) {
            var mImg = document.createElement("img");
            mImg.className = "msc-msg-img";
            mImg.src = c.image; mImg.alt = "attachment";
            mImg.addEventListener("click", function () { openLightbox(c.image); });
            bubble.appendChild(mImg);
        }

        body.appendChild(head);
        body.appendChild(bubble);

        if (isOwn) {
            var delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "msc-msg-delete";
            delBtn.textContent = "🗑 Delete";
            delBtn.addEventListener("click", function (e) {
                e.stopPropagation();
                apiDelete(API_BASE + "/comments/" + encodeURIComponent(c._id), { client_id: profile.client_id })
                    .then(function (res) {
                        if (res.ok) {
                            wrap.remove();
                            delete renderedIds[c._id];
                            if (!feed.querySelector(".msc-msg")) emptyState.style.display = "";
                        } else {
                            toast((res.data && res.data.error) || "Delete nahi ho paya.");
                        }
                    }).catch(function () { toast("Network error — dobara try karein."); });
            });
            body.appendChild(delBtn);

            // Hold-to-reveal delete
            var startPress = function () {
                pressTimer = setTimeout(function () {
                    if (armedMsgEl && armedMsgEl !== wrap) armedMsgEl.classList.remove("msc-armed");
                    wrap.classList.add("msc-armed");
                    armedMsgEl = wrap;
                }, 500);
            };
            var cancelPress = function () { clearTimeout(pressTimer); };
            bubble.addEventListener("touchstart", startPress, { passive: true });
            bubble.addEventListener("touchend", cancelPress);
            bubble.addEventListener("touchmove", cancelPress);
            bubble.addEventListener("mousedown", startPress);
            bubble.addEventListener("mouseup", cancelPress);
            bubble.addEventListener("mouseleave", cancelPress);
        }

        wrap.appendChild(avatar);
        wrap.appendChild(body);

        var stickToBottom = isNearBottom();
        emptyState.style.display = "none";
        feed.appendChild(wrap);
        if (stickToBottom) feed.scrollTop = feed.scrollHeight;

        if (!lastCreatedAt || c.created_at > lastCreatedAt) lastCreatedAt = c.created_at;
    }

    function loadInitial() {
        apiGet(API_BASE + "/comments").then(function (res) {
            if (!res || !res.ok || !res.comments) return;
            res.comments.forEach(renderMessage);
            feed.scrollTop = feed.scrollHeight;
        }).catch(function () {});
    }

    function pollNew() {
        var url = API_BASE + "/comments" + (lastCreatedAt ? ("?since=" + encodeURIComponent(lastCreatedAt)) : "");
        apiGet(url).then(function (res) {
            if (!res || !res.ok || !res.comments) return;
            res.comments.forEach(renderMessage);
        }).catch(function () {});
    }

    var pollTimer = null;
    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(pollNew, 3500);
    }
    function stopPolling() {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    // ─────────────────────────── Emoji picker ───────────────────────────
    var EMOJIS = [
        "😀","😁","😂","🤣","😊","😍","😘","😜","🤔","😎",
        "😢","😭","😡","😱","🥳","👍","👎","👏","🙏","💪",
        "❤️","🔥","🎉","✨","⭐","💯","👌","🙌","🤝","👀",
        "😴","🤗","😇","🥰","😅","🤩","😆","🙄","😬","🤯",
        "📚","✏️","💡","🎯","⏰","✅","❌","❓","❗","💬"
    ];
    var emojiBuilt = false;
    function buildEmojiPicker() {
        if (emojiBuilt) return;
        emojiBuilt = true;
        EMOJIS.forEach(function (em) {
            var b = document.createElement("button");
            b.type = "button";
            b.textContent = em;
            b.addEventListener("click", function () {
                insertAtCursor(textarea, em);
                textarea.focus();
            });
            emojiPicker.appendChild(b);
        });
    }
    function insertAtCursor(el, text) {
        var start = el.selectionStart || el.value.length;
        var end = el.selectionEnd || el.value.length;
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
        var pos = start + text.length;
        el.setSelectionRange(pos, pos);
        autosize();
        updateSendState();
    }
    emojiBtn.addEventListener("click", function () {
        buildEmojiPicker();
        emojiPicker.hidden = !emojiPicker.hidden;
    });

    // ─────────────────────────── Composer: image attach ───────────────────────────
    var pendingImage = null; // compressed dataURL
    imageBtn.addEventListener("click", function () { imageInput.click(); });
    imageInput.addEventListener("change", function () {
        var file = imageInput.files && imageInput.files[0];
        imageInput.value = "";
        if (!file) return;
        if (file.size > MAX_IMAGE_INPUT_BYTES) {
            toast("Image bahut badi hai (max 10MB).");
            return;
        }
        compressImage(file, 1280, 0.72).then(function (dataUrl) {
            pendingImage = dataUrl;
            imagePreviewImg.src = dataUrl;
            imagePreview.hidden = false;
            updateSendState();
        }).catch(function (e) { toast(e.message || "Image process nahi ho payi."); });
    });
    imageRemove.addEventListener("click", function () {
        pendingImage = null;
        imagePreview.hidden = true;
        imagePreviewImg.src = "";
        updateSendState();
    });

    function autosize() {
        textarea.style.height = "auto";
        textarea.style.height = Math.min(110, textarea.scrollHeight) + "px";
    }
    textarea.addEventListener("input", function () { autosize(); updateSendState(); });

    function updateSendState() {
        var hasContent = textarea.value.trim().length > 0 || !!pendingImage;
        sendBtn.disabled = !hasContent;
    }
    updateSendState();

    // ─────────────────────────── Sending ───────────────────────────
    function doSend() {
        var text = textarea.value.trim();
        if (!text && !pendingImage) return;
        if (!profile) { openProfileModal(); return; }

        sendBtn.disabled = true;
        apiPost(API_BASE + "/comments", {
            client_id: profile.client_id,
            name: profile.name,
            avatar: profile.avatar || null,
            text: text,
            image: pendingImage || null
        }).then(function (res) {
            if (res.ok && res.data && res.data.comment) {
                renderMessage(res.data.comment);
                textarea.value = "";
                autosize();
                pendingImage = null;
                imagePreview.hidden = true;
                imagePreviewImg.src = "";
            } else {
                toast((res.data && res.data.error) || "Comment bhej nahi paya, dobara try karein.");
            }
        }).catch(function () {
            toast("Network error — dobara try karein.");
        }).finally(function () { updateSendState(); });
    }
    sendBtn.addEventListener("click", doSend);
    textarea.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            doSend();
        }
    });

    // ─────────────────────────── Profile modal (create / settings) ───────────────────────────
    var pendingAvatar = null;

    function openProfileModal() {
        pendingAvatar = (profile && profile.avatar) || null;
        nameInput.value = (profile && profile.name) || "";
        if (pendingAvatar) {
            avatarPickImg.src = pendingAvatar; avatarPickImg.hidden = false; avatarPickIcon.hidden = true;
        } else {
            avatarPickImg.hidden = true; avatarPickIcon.hidden = false;
        }
        updateProfileSaveState();
        profileOverlay.hidden = false;
    }
    function closeProfileModal() { profileOverlay.hidden = true; }

    function updateProfileSaveState() {
        var n = nameInput.value.trim();
        if (nameCounter) nameCounter.textContent = n.length + "/" + MAX_NAME_LEN;
        profileSave.disabled = n.length === 0;
    }
    nameInput.addEventListener("input", function () {
        if (nameInput.value.length > MAX_NAME_LEN) nameInput.value = nameInput.value.slice(0, MAX_NAME_LEN);
        updateProfileSaveState();
    });

    avatarPick.addEventListener("click", function () { avatarInput.click(); });
    avatarInput.addEventListener("change", function () {
        var file = avatarInput.files && avatarInput.files[0];
        avatarInput.value = "";
        if (!file) return;
        if (file.size > MAX_AVATAR_INPUT_BYTES) {
            toast("Photo bahut badi hai (max 10MB).");
            return;
        }
        compressImage(file, 320, 0.8).then(function (dataUrl) {
            pendingAvatar = dataUrl;
            avatarPickImg.src = dataUrl; avatarPickImg.hidden = false; avatarPickIcon.hidden = true;
        }).catch(function (e) { toast(e.message || "Photo process nahi ho payi."); });
    });

    profileCancel.addEventListener("click", function () {
        if (!profile) { closeCommentPanel(); }
        closeProfileModal();
    });

    profileSave.addEventListener("click", function () {
        var n = nameInput.value.trim().slice(0, MAX_NAME_LEN);
        if (!n) return;
        var clientId = (profile && profile.client_id) || HEARTBEAT_CLIENT_ID || genClientId();
        saveProfile({ name: n, avatar: pendingAvatar || null, client_id: clientId });
        closeProfileModal();
        toast("Profile save ho gayi ✅");
    });

    settingsBtn.addEventListener("click", openProfileModal);

    // ─────────────────────────── Panel open/close ───────────────────────────
    var panelOpen = false;
    function openCommentPanel() {
        panelOpen = true;
        panel.hidden = false;
        toggleLabel.textContent = "✕ Close";
        loadInitial();
        startPolling();
        if (!profile) openProfileModal();
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    function closeCommentPanel() {
        panelOpen = false;
        panel.hidden = true;
        toggleLabel.textContent = "💬 Open";
        stopPolling();
    }
    toggleBox.addEventListener("click", function () {
        if (panelOpen) closeCommentPanel(); else openCommentPanel();
    });

    // Pause polling when tab hidden (saves battery/requests), resume when visible again.
    document.addEventListener("visibilitychange", function () {
        if (!panelOpen) return;
        if (document.hidden) stopPolling(); else { pollNew(); startPolling(); }
    });
})();
