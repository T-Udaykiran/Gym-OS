/**
 * GymOS AppInnerHeader Shared Component
 * Standardized inner page header component.
 * 
 * Specs:
 * - Height: 60px (respecting device safe area)
 * - Horizontal Padding: 20px
 * - Background: Application background (#000)
 * - Divider: 1px subtle bottom border
 * - Back Button: 24px Chevron Left icon inside 44x44px touch target, no circular/filled background
 * - Title: 24px, weight 700, white, vertically centered, immediately after back icon
 * - Right Action: Empty by default, displays custom element/html when provided
 */

class AppInnerHeader extends HTMLElement {
    constructor() {
        super();
        this._title = '';
        this._showBack = true;
        this._rightAction = null;
        this._onBack = null;
        this._onRightAction = null;
    }

    static get observedAttributes() {
        return ['title', 'show-back', 'right-action', 'onback', 'onrightaction'];
    }

    connectedCallback() {
        this.render();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return;
        if (name === 'title') {
            this._title = newValue || '';
        } else if (name === 'show-back') {
            this._showBack = newValue !== 'false';
        } else if (name === 'right-action') {
            this._rightAction = newValue;
        } else if (name === 'onback') {
            this._onBack = newValue;
        } else if (name === 'onrightaction') {
            this._onRightAction = newValue;
        }
        this.render();
    }

    get title() {
        return this._title || this.getAttribute('title') || '';
    }

    set title(val) {
        this._title = val;
        this.setAttribute('title', val);
        this.render();
    }

    get showBack() {
        return this._showBack;
    }

    set showBack(val) {
        this._showBack = Boolean(val);
        if (val) {
            this.setAttribute('show-back', 'true');
        } else {
            this.setAttribute('show-back', 'false');
        }
        this.render();
    }

    get rightAction() {
        return this._rightAction;
    }

    set rightAction(val) {
        this._rightAction = val;
        this.render();
    }

    get onBack() {
        return this._onBack;
    }

    set onBack(fn) {
        this._onBack = fn;
        this.render();
    }

    get onRightAction() {
        return this._onRightAction;
    }

    set onRightAction(fn) {
        this._onRightAction = fn;
        this.render();
    }

    handleBackClick(e) {
        if (e) e.preventDefault();
        if (typeof this._onBack === 'function') {
            this._onBack(e);
        } else if (typeof this._onBack === 'string' && this._onBack.trim()) {
            new Function('event', this._onBack).call(this, e);
        } else {
            const attrOnBack = this.getAttribute('onback');
            if (attrOnBack) {
                new Function('event', attrOnBack).call(this, e);
            }
        }
    }

    handleRightActionClick(e) {
        if (e) e.preventDefault();
        if (typeof this._onRightAction === 'function') {
            this._onRightAction(e);
        } else if (typeof this._onRightAction === 'string' && this._onRightAction.trim()) {
            new Function('event', this._onRightAction).call(this, e);
        } else {
            const attrOnRight = this.getAttribute('onrightaction');
            if (attrOnRight) {
                new Function('event', attrOnRight).call(this, e);
            }
        }
    }

    render() {
        const titleText = this.title;
        const showBack = this.showBack;

        this.innerHTML = `
            <header class="app-inner-header">
                <div class="app-inner-header-left">
                    ${showBack ? `
                        <button type="button" class="app-inner-header-back-btn" aria-label="Back">
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="15 18 9 12 15 6"></polyline>
                            </svg>
                        </button>
                    ` : ''}
                    <h2 class="app-inner-header-title">${titleText}</h2>
                </div>
                <div class="app-inner-header-right"></div>
            </header>
        `;

        // Attach Back listener
        if (showBack) {
            const backBtn = this.querySelector('.app-inner-header-back-btn');
            if (backBtn) {
                backBtn.addEventListener('click', (e) => this.handleBackClick(e));
            }
        }

        // Attach Right Action content
        const rightContainer = this.querySelector('.app-inner-header-right');
        if (rightContainer) {
            if (this._rightAction instanceof HTMLElement) {
                rightContainer.appendChild(this._rightAction);
            } else if (typeof this._rightAction === 'string' && this._rightAction.trim()) {
                rightContainer.innerHTML = this._rightAction;
            }
            if (rightContainer.children.length > 0 || rightContainer.innerHTML.trim() !== '') {
                rightContainer.addEventListener('click', (e) => this.handleRightActionClick(e));
            }
        }
    }
}

if (!customElements.get('app-inner-header')) {
    customElements.define('app-inner-header', AppInnerHeader);
}

// Global factory helper supporting: AppInnerHeader({ title, showBack, rightAction, onBack, onRightAction })
window.AppInnerHeader = function(props = {}) {
    const el = document.createElement('app-inner-header');
    if (props.title) el.title = props.title;
    if (props.showBack !== undefined) el.showBack = props.showBack;
    if (props.rightAction) el.rightAction = props.rightAction;
    if (props.onBack) el.onBack = props.onBack;
    if (props.onRightAction) el.onRightAction = props.onRightAction;
    return el;
};
