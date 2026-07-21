// Shared Date Picker & DOB Helper Module for GymOS
// Enforces canonical storage format YYYY-MM-DD, display format "12 May 1994",
// and age validation rules (Min age 10, Max age 120, No future dates).
(function (global) {
    const MONTH_NAMES = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    function getToday() {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    }

    function formatIso(dateObj) {
        if (!dateObj) return '';
        let d = dateObj;
        if (typeof d === 'string') {
            d = parseDob(d);
        }
        if (!d || isNaN(d.getTime())) return '';
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function formatDisplay(dateObj) {
        if (!dateObj) return '';
        let d = dateObj;
        if (typeof d === 'string') {
            d = parseDob(d);
        }
        if (!d || isNaN(d.getTime())) return '';
        const day = d.getDate();
        const monthStr = MONTH_NAMES[d.getMonth()].slice(0, 3);
        const year = d.getFullYear();
        return `${day} ${monthStr} ${year}`;
    }

    function parseDob(val) {
        if (!val) return null;
        if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
        let str = String(val).trim();
        if (str.includes('T')) {
            str = str.split('T')[0];
        }
        str = str.replace(',', '').trim();
        // Check ISO format YYYY-MM-DD
        const isoMatch = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/.exec(str);
        if (isoMatch) {
            const d = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
            return isNaN(d.getTime()) ? null : d;
        }
        // Check DD/MM/YYYY format
        const dmyMatch = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(str);
        if (dmyMatch) {
            const d = new Date(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1]));
            return isNaN(d.getTime()) ? null : d;
        }
        const parsed = new Date(str);
        return isNaN(parsed.getTime()) ? null : parsed;
    }

    function getMinDobIso() {
        const today = getToday();
        const minYear = today.getFullYear() - 120;
        return `${minYear}-01-01`;
    }

    function getMaxDobIso() {
        const today = getToday();
        const maxYear = today.getFullYear() - 10;
        const m = String(today.getMonth() + 1).padStart(2, '0');
        const d = String(today.getDate()).padStart(2, '0');
        return `${maxYear}-${m}-${d}`;
    }

    function validateDob(dobVal, required = false) {
        if (!dobVal || String(dobVal).trim() === '') {
            if (required) return { valid: false, message: 'Date of birth is required.' };
            return { valid: true, message: '' };
        }
        const d = parseDob(dobVal);
        if (!d) {
            return { valid: false, message: 'Please enter a valid date of birth.' };
        }
        const today = getToday();
        if (d > today) {
            return { valid: false, message: 'Date of birth cannot be in the future.' };
        }
        const ageYears = (today.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        if (ageYears < 10) {
            return { valid: false, message: 'Member must be at least 10 years old.' };
        }
        if (ageYears > 120) {
            return { valid: false, message: 'Please enter a valid date of birth.' };
        }
        return { valid: true, message: '' };
    }

    function setupDateInput(inputElem) {
        if (!inputElem) return;
        inputElem.min = getMinDobIso();
        inputElem.max = getMaxDobIso();
    }

    global.MemberDatePicker = {
        formatIso,
        formatDisplay,
        parseDob,
        getMinDobIso,
        getMaxDobIso,
        validateDob,
        setupDateInput
    };
})(window);
