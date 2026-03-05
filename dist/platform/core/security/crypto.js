"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptSensitive = encryptSensitive;
exports.decryptSensitive = decryptSensitive;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../../config/env");
const key = crypto_1.default.createHash('sha256').update(env_1.env.jwtSecret).digest();
function encryptSensitive(plainText) {
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}.${tag.toString('hex')}.${encrypted.toString('hex')}`;
}
function decryptSensitive(payload) {
    const [ivHex, tagHex, cipherHex] = payload.split('.');
    const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
    return plain.toString('utf8');
}
