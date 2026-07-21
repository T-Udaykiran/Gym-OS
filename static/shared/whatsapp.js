// static/shared/whatsapp.js

const WhatsAppUtility = {
    normalizePhone(phone) {
        if (!phone) return null;
        // Clean all non-digit characters
        let clean = phone.toString().replace(/\D/g, '');
        if (!clean) return null;
        
        // Support: 9876543210 (10 digits) -> prepend 91
        // Support: +919876543210 (12 digits) -> keeps 919876543210
        // Support: 919876543210 (12 digits) -> keeps 919876543210
        if (clean.length === 10) {
            clean = '91' + clean;
        }
        
        // Validate length: should be exactly 12 digits (91 + 10 digits)
        if (clean.length !== 12) {
            return null;
        }
        
        return clean;
    },
    
    generateWhatsAppMessage(template, variables) {
        if (!template) return '';
        let resolved = template;
        for (const [key, value] of Object.entries(variables)) {
            resolved = resolved.replaceAll(`{${key}}`, value || '');
        }
        return resolved;
    },
    
    buildWhatsAppUrl(phone, message) {
        const normalizedPhone = this.normalizePhone(phone);
        if (!normalizedPhone) return null;
        return `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`;
    },
    
    openWhatsApp(phone, message) {
        const url = this.buildWhatsAppUrl(phone, message);
        if (!url) {
            alert("Member does not have a valid WhatsApp number.");
            return false;
        }
        window.open(url, "_blank", "noopener,noreferrer");
        return true;
    }
};

// Export to window if running in browser
if (typeof window !== 'undefined') {
    window.WhatsAppUtility = WhatsAppUtility;
}
