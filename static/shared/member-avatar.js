// Canonical member avatar helpers & Web Component, shared by Member App and Owner/Admin Panel.
// Single source of truth for: initials generation, photo/initials fallback, broken-image recovery,
// and uniform rendering across all screens.
(function (global) {
    function getInitials(firstName, lastName) {
        const fn = (firstName || '').trim();
        const ln = (lastName || '').trim();

        if (fn && ln) {
            return (fn.charAt(0) + ln.charAt(0)).toUpperCase();
        }
        if (fn) {
            const parts = fn.split(/\s+/).filter(Boolean);
            if (parts.length >= 2) {
                return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
            }
            return fn.charAt(0).toUpperCase();
        }
        if (ln) {
            return ln.charAt(0).toUpperCase();
        }
        return 'M';
    }

    function generateInitialsDataUrl(firstName, lastName, size) {
        size = size || 100;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const grad = ctx.createLinearGradient(0, 0, size, size);
        grad.addColorStop(0, '#1c1c1e');
        grad.addColorStop(1, '#2c2c2e');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(199, 255, 36, 0.35)';
        ctx.lineWidth = Math.max(2, size * 0.04);
        ctx.stroke();

        ctx.fillStyle = '#c7ff24';
        ctx.font = `900 ${Math.floor(size * 0.4)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(getInitials(firstName, lastName), size / 2, size / 2 + size * 0.03);

        return canvas.toDataURL('image/png');
    }

    function hasRealPhoto(memberOrPhoto) {
        const photo = (memberOrPhoto && typeof memberOrPhoto === 'object')
            ? (memberOrPhoto.profile_photo || memberOrPhoto.profilePhoto)
            : memberOrPhoto;
        return !!(photo && String(photo).trim() !== '');
    }

    function resolveSrc(memberOrPhoto, firstName, lastName) {
        if (memberOrPhoto && typeof memberOrPhoto === 'object') {
            const photo = memberOrPhoto.profile_photo || memberOrPhoto.profilePhoto;
            if (photo && String(photo).trim() !== '') return photo;
            return generateInitialsDataUrl(memberOrPhoto.first_name || firstName, memberOrPhoto.last_name || lastName);
        }
        if (typeof memberOrPhoto === 'string' && memberOrPhoto.trim() !== '') {
            return memberOrPhoto;
        }
        return generateInitialsDataUrl(firstName, lastName);
    }

    function applyFallback(imgEl, member, firstName, lastName) {
        if (!imgEl) return;
        const fn = member && typeof member === 'object' ? member.first_name : firstName;
        const ln = member && typeof member === 'object' ? member.last_name : lastName;
        imgEl.onerror = function () {
            imgEl.onerror = null;
            imgEl.src = generateInitialsDataUrl(fn, ln);
        };
    }

    function handleImgError(imgEl) {
        if (!imgEl) return;
        imgEl.onerror = null;
        imgEl.src = generateInitialsDataUrl(imgEl.dataset.fn, imgEl.dataset.ln);
    }

    function escapeAttr(str) {
        return String(str || '').replace(/"/g, '&quot;');
    }

    function html(member, opts) {
        opts = opts || {};
        const size = opts.size || 36;
        const className = opts.className || '';
        const extraStyle = opts.style || '';
        const src = resolveSrc(member);
        const fn = member ? (member.first_name || '') : (opts.firstName || '');
        const ln = member ? (member.last_name || '') : (opts.lastName || '');
        return `<img src="${src}" alt="Profile photo" class="member-avatar-img ${className}" ` +
            `data-fn="${escapeAttr(fn)}" data-ln="${escapeAttr(ln)}" ` +
            `style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;${extraStyle}" ` +
            `onerror="MemberAvatar.handleImgError(this)">`;
    }

    // Web Component Definition: <member-avatar>
    class MemberAvatarElement extends HTMLElement {
        constructor() {
            super();
            this._src = '';
            this._firstName = '';
            this._lastName = '';
            this._size = 44;
            this._editable = false;
        }

        static get observedAttributes() {
            return ['src', 'first-name', 'last-name', 'size', 'editable'];
        }

        connectedCallback() {
            this.render();
        }

        attributeChangedCallback(name, oldValue, newValue) {
            if (oldValue === newValue) return;
            if (name === 'src') this._src = newValue || '';
            if (name === 'first-name') this._firstName = newValue || '';
            if (name === 'last-name') this._lastName = newValue || '';
            if (name === 'size') this._size = parseInt(newValue, 10) || 44;
            if (name === 'editable') this._editable = newValue === 'true' || newValue === '';
            this.render();
        }

        get src() { return this._src; }
        set src(val) { this._src = val || ''; this.setAttribute('src', this._src); this.render(); }

        get firstName() { return this._firstName; }
        set firstName(val) { this._firstName = val || ''; this.setAttribute('first-name', this._firstName); this.render(); }

        get lastName() { return this._lastName; }
        set lastName(val) { this._lastName = val || ''; this.setAttribute('last-name', this._lastName); this.render(); }

        get size() { return this._size; }
        set size(val) { this._size = parseInt(val, 10) || 44; this.setAttribute('size', String(this._size)); this.render(); }

        get editable() { return this._editable; }
        set editable(val) { this._editable = Boolean(val); this.setAttribute('editable', String(this._editable)); this.render(); }

        update(data = {}) {
            if (data.src !== undefined || data.profile_photo !== undefined) {
                this._src = data.src !== undefined ? data.src : data.profile_photo;
            }
            if (data.firstName !== undefined || data.first_name !== undefined) {
                this._firstName = data.firstName !== undefined ? data.firstName : data.first_name;
            }
            if (data.lastName !== undefined || data.last_name !== undefined) {
                this._lastName = data.lastName !== undefined ? data.lastName : data.last_name;
            }
            if (data.size !== undefined) this._size = parseInt(data.size, 10) || 44;
            if (data.editable !== undefined) this._editable = Boolean(data.editable);
            this.render();
        }

        render() {
            const size = this.size;
            const src = resolveSrc(this.src, this.firstName, this.lastName);
            const isEditable = this.editable;

            const badgeSize = Math.max(18, Math.floor(size * 0.32));
            const iconSize = Math.max(10, Math.floor(badgeSize * 0.6));

            this.innerHTML = `
                <div class="member-avatar-host" style="width: ${size}px; height: ${size}px; position: relative; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;">
                    <img src="${src}" alt="Member avatar" class="member-avatar-img"
                        data-fn="${escapeAttr(this.firstName)}" data-ln="${escapeAttr(this.lastName)}"
                        style="width: ${size}px; height: ${size}px; border-radius: 50%; object-fit: cover; border: 1.5px solid rgba(255,255,255,0.15); box-sizing: border-box; display: block;"
                        onerror="MemberAvatar.handleImgError(this)" />
                    ${isEditable ? `
                        <div class="member-avatar-badge" title="Change photo" style="position: absolute; bottom: 0; right: 0; width: ${badgeSize}px; height: ${badgeSize}px; border-radius: 50%; background: #c7ff24; display: flex; align-items: center; justify-content: center; border: 2px solid #000; box-shadow: 0 2px 6px rgba(0,0,0,0.4); pointer-events: none; z-index: 2;">
                            <svg xmlns="http://www.w3.org/2000/svg" width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                                <circle cx="12" cy="13" r="4"></circle>
                            </svg>
                        </div>
                    ` : ''}
                </div>
            `;
        }
    }

    if (!customElements.get('member-avatar')) {
        customElements.define('member-avatar', MemberAvatarElement);
    }

    global.MemberAvatar = {
        getInitials,
        generateInitialsDataUrl,
        resolveSrc,
        hasRealPhoto,
        applyFallback,
        handleImgError,
        html
    };
})(window);
