"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const LilypadLogger_1 = __importDefault(require("./LilypadLogger"));
(0, vitest_1.describe)('LilypadLogger', () => {
    let mockComponent;
    let mockComponent2;
    (0, vitest_1.beforeEach)(() => {
        mockComponent = {
            output: vitest_1.vi.fn(),
            getTimestamp: vitest_1.vi.fn(() => new Date().toISOString()),
            formatMessage: vitest_1.vi.fn((channel, message) => `[${channel}] ${message}`),
            send: vitest_1.vi.fn(),
        };
        mockComponent2 = {
            output: vitest_1.vi.fn(),
            getTimestamp: vitest_1.vi.fn(() => new Date().toISOString()),
            formatMessage: vitest_1.vi.fn((channel, message) => `[${channel}] ${message}`),
            send: vitest_1.vi.fn(),
        };
    });
    (0, vitest_1.it)('should create logger with dynamic methods for each channel', () => {
        const logger = (0, LilypadLogger_1.default)({
            components: {
                info: [mockComponent],
                error: [mockComponent],
            },
        });
        (0, vitest_1.expect)(typeof logger.info).toBe('function');
        (0, vitest_1.expect)(typeof logger.error).toBe('function');
    });
    (0, vitest_1.it)('should call component.output with string message', () => {
        const logger = (0, LilypadLogger_1.default)({
            components: {
                info: [mockComponent],
                error: [mockComponent],
            },
        });
        logger.info('test message');
        (0, vitest_1.expect)(mockComponent.output).toHaveBeenCalledWith('info', 'test message');
    });
    (0, vitest_1.it)('should stringify non-string messages', () => {
        const logger = (0, LilypadLogger_1.default)({
            components: {
                info: [mockComponent],
                error: [mockComponent],
            },
        });
        const obj = { key: 'value' };
        logger.info(obj);
        (0, vitest_1.expect)(mockComponent.output).toHaveBeenCalledWith('info', JSON.stringify(obj));
    });
    (0, vitest_1.it)('should route messages to all registered components', async () => {
        const logger = (0, LilypadLogger_1.default)({
            components: {
                info: [mockComponent, mockComponent2],
                error: [mockComponent, mockComponent2],
            },
        });
        await logger.info('test');
        (0, vitest_1.expect)(mockComponent.output).toHaveBeenCalled();
        (0, vitest_1.expect)(mockComponent2.output).toHaveBeenCalled();
    });
    (0, vitest_1.it)('should handle component errors with errorLogging callback', () => {
        mockComponent.output = vitest_1.vi.fn(() => {
            throw new Error('Component error');
        });
        const errorLogging = vitest_1.vi.fn();
        const logger = (0, LilypadLogger_1.default)({
            components: {
                info: [mockComponent],
                error: [],
            },
            errorLogging,
        });
        logger.info('test');
        (0, vitest_1.expect)(errorLogging).toHaveBeenCalledWith(vitest_1.expect.any(Error));
    });
    (0, vitest_1.it)('should use console.error as fallback for component errors', () => {
        mockComponent.output = vitest_1.vi.fn(() => {
            throw new Error('Component error');
        });
        const consoleSpy = vitest_1.vi.spyOn(console, 'error').mockImplementation(() => { });
        const logger = (0, LilypadLogger_1.default)({
            components: {
                info: [mockComponent],
                error: [],
            },
        });
        logger.info('test');
        (0, vitest_1.expect)(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
    (0, vitest_1.it)('should register new components', async () => {
        const logger = (0, LilypadLogger_1.default)({
            components: {
                info: [mockComponent],
                error: [],
            },
        });
        logger.register({
            info: [mockComponent2],
        });
        await logger.info('test');
        (0, vitest_1.expect)(mockComponent.output).toHaveBeenCalled();
        (0, vitest_1.expect)(mockComponent2.output).toHaveBeenCalled();
    });
    (0, vitest_1.it)('should return this for method chaining on register', () => {
        const logger = (0, LilypadLogger_1.default)({
            components: {
                info: [mockComponent],
                error: [],
            },
        });
        const result = logger.register({
            info: [mockComponent2],
            error: [],
        });
        (0, vitest_1.expect)(result).toBe(logger);
    });
});
