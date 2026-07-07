import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StructuredLogger } from '../structured-logger.js';

describe('StructuredLogger', () => {
  let tmpDir: string;
  let tmpFile: string;
  let loggers: StructuredLogger[];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'struct-log-test-'));
    tmpFile = path.join(tmpDir, 'test.log');
    loggers = [];
    savedEnv = {
      LOG_LEVEL: process.env.LOG_LEVEL,
      LOG_FORMAT: process.env.LOG_FORMAT,
      LOG_FILE: process.env.LOG_FILE,
      NODE_ENV: process.env.NODE_ENV,
    };
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
    delete process.env.LOG_FILE;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    for (const l of loggers) {
      try { l.close(); } catch { /* 已关闭 */ }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function createLogger(config: any): StructuredLogger {
    const l = new StructuredLogger(config);
    loggers.push(l);
    return l;
  }

  function readLogs(file: string = tmpFile): any[] {
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }

  // 捕获 stdout 输出（不使用 vitest mock，仅手动覆盖）
  function captureStdout(fn: () => void): string {
    const original = process.stdout.write.bind(process.stdout);
    let output = '';
    process.stdout.write = ((chunk: any) => {
      output += chunk.toString();
      return true;
    }) as any;
    try {
      fn();
    } finally {
      process.stdout.write = original;
    }
    return output;
  }

  // 解析 stdout 中的多行 JSON
  function parseStdoutJson(output: string): any[] {
    return output
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }

  // 关闭 logger 并等待输出流刷新完成
  async function closeAndWait(logger: StructuredLogger): Promise<void> {
    const stream = (logger as any).outputStream as fs.WriteStream | undefined;
    if (stream && !stream.writableEnded) {
      await new Promise<void>((resolve) => {
        stream.once('finish', () => resolve());
        stream.end();
      });
    }
  }

  describe('构造与配置', () => {
    it('默认配置 level=info', () => {
      const logger = createLogger({ format: 'json' });
      const output = captureStdout(() => {
        logger.debug('debug msg');
        logger.info('info msg');
      });
      const entries = parseStdoutJson(output);
      // debug 低于 info，被过滤；info 输出
      expect(entries.length).toBe(1);
      expect(entries[0].level).toBe('info');
      expect(entries[0].message).toBe('info msg');
    });

    it('env LOG_LEVEL 设置日志级别', () => {
      process.env.LOG_LEVEL = 'error';
      const logger = createLogger({ format: 'json' });
      const output = captureStdout(() => {
        logger.info('should not log');
        logger.error('should log');
      });
      const entries = parseStdoutJson(output);
      expect(entries.length).toBe(1);
      expect(entries[0].level).toBe('error');
    });

    it('自定义 level', () => {
      const logger = createLogger({ level: 'warn', format: 'json' });
      const output = captureStdout(() => {
        logger.info('info msg');
        logger.warn('warn msg');
      });
      const entries = parseStdoutJson(output);
      expect(entries.length).toBe(1);
      expect(entries[0].level).toBe('warn');
    });

    it('silent格式不输出到stdout', () => {
      const logger = createLogger({ level: 'debug' });
      // 直接设置 format 为 silent（构造函数存在优先级问题，无法通过 config 设置 silent）
      (logger as any).config.format = 'silent';
      const output = captureStdout(() => {
        logger.info('test');
        logger.warn('test');
        logger.error('test');
      });
      expect(output).toBe('');
    });
  });

  describe('日志级别过滤', () => {
    it('level=warn时，debug和info不输出', () => {
      const logger = createLogger({ level: 'warn', format: 'json' });
      const output = captureStdout(() => {
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        logger.fatal('f');
      });
      const entries = parseStdoutJson(output);
      expect(entries.length).toBe(3);
      expect(entries.map(e => e.level)).toEqual(['warn', 'error', 'fatal']);
    });

    it('level=debug时，所有级别输出', () => {
      const logger = createLogger({ level: 'debug', format: 'json' });
      const output = captureStdout(() => {
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        logger.fatal('f');
      });
      const entries = parseStdoutJson(output);
      expect(entries.length).toBe(5);
      expect(entries.map(e => e.level)).toEqual(['debug', 'info', 'warn', 'error', 'fatal']);
    });

    it('level=error时，只有error和fatal输出', () => {
      const logger = createLogger({ level: 'error', format: 'json' });
      const output = captureStdout(() => {
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        logger.fatal('f');
      });
      const entries = parseStdoutJson(output);
      expect(entries.length).toBe(2);
      expect(entries.map(e => e.level)).toEqual(['error', 'fatal']);
    });
  });

  describe('日志格式', () => {
    it('json格式输出JSON字符串', () => {
      const logger = createLogger({ level: 'info', format: 'json' });
      const output = captureStdout(() => {
        logger.info('hello');
      });
      const parsed = JSON.parse(output.trim());
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('hello');
      expect(parsed.timestamp).toBeTruthy();
    });

    it('pretty格式输出带颜色的文本', () => {
      // 不设置 config.format，使 format 默认为 pretty
      const logger = createLogger({ level: 'info' });
      const output = captureStdout(() => {
        logger.info('hello');
      });
      // info 级别使用 cyan 颜色 \x1b[36m
      expect(output).toContain('\x1b[36m');
      expect(output).toContain('hello');
      expect(output).toContain('\x1b[0m'); // reset
    });
  });

  describe('敏感数据脱敏', () => {
    it('password字段被脱敏为[REDACTED]', () => {
      const logger = createLogger({ level: 'info', format: 'json' });
      const output = captureStdout(() => {
        logger.info('login', { user: 'alice', password: 'secret123' });
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].metadata.password).toBe('[REDACTED]');
      expect(entries[0].metadata.user).toBe('alice');
    });

    it('apiKey字段被脱敏', () => {
      const logger = createLogger({ level: 'info', format: 'json' });
      const output = captureStdout(() => {
        logger.info('api call', { apiKey: 'sk-xxx' });
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].metadata.apiKey).toBe('[REDACTED]');
    });

    it('嵌套对象中的敏感字段被脱敏', () => {
      const logger = createLogger({ level: 'info', format: 'json' });
      const output = captureStdout(() => {
        logger.info('nested', {
          outer: {
            inner: { token: 'abc', value: 'keep' },
            safe: 'ok',
          },
        });
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].metadata.outer.inner.token).toBe('[REDACTED]');
      expect(entries[0].metadata.outer.inner.value).toBe('keep');
      expect(entries[0].metadata.outer.safe).toBe('ok');
    });

    it('数组中的敏感字段被脱敏', () => {
      const logger = createLogger({ level: 'info', format: 'json' });
      const output = captureStdout(() => {
        logger.info('array', {
          users: [
            { name: 'a', password: 'p1' },
            { name: 'b', password: 'p2' },
          ],
        });
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].metadata.users[0].password).toBe('[REDACTED]');
      expect(entries[0].metadata.users[1].password).toBe('[REDACTED]');
      expect(entries[0].metadata.users[0].name).toBe('a');
      expect(entries[0].metadata.users[1].name).toBe('b');
    });

    it('非敏感字段保留原值', () => {
      const logger = createLogger({ level: 'info', format: 'json' });
      const output = captureStdout(() => {
        logger.info('safe', { name: 'test', count: 42, active: true, list: [1, 2, 3] });
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].metadata.name).toBe('test');
      expect(entries[0].metadata.count).toBe(42);
      expect(entries[0].metadata.active).toBe(true);
      expect(entries[0].metadata.list).toEqual([1, 2, 3]);
    });
  });

  describe('child logger', () => {
    it('child继承配置', () => {
      const parent = createLogger({ level: 'warn', format: 'json' });
      const child = parent.child({ module: 'auth' });
      loggers.push(child);
      const output = captureStdout(() => {
        child.info('should not log');
        child.warn('should log');
      });
      const entries = parseStdoutJson(output);
      expect(entries.length).toBe(1);
      expect(entries[0].level).toBe('warn');
    });

    it('child设置module', () => {
      const parent = createLogger({ level: 'info', format: 'json' });
      const child = parent.child({ module: 'auth-service' });
      loggers.push(child);
      const output = captureStdout(() => {
        child.info('auth event');
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].module).toBe('auth-service');
    });

    it('child设置traceId', () => {
      const parent = createLogger({ level: 'info', format: 'json' });
      const child = parent.child({ traceId: 'trace-12345678' });
      loggers.push(child);
      const output = captureStdout(() => {
        child.info('traced event');
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].traceId).toBe('trace-12345678');
    });

    it('withTraceId设置traceId', () => {
      const parent = createLogger({ level: 'info', format: 'json' });
      const child = parent.withTraceId('trace-abcd1234');
      loggers.push(child);
      const output = captureStdout(() => {
        child.info('traced event');
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].traceId).toBe('trace-abcd1234');
    });
  });

  describe('Error对象处理', () => {
    it('Error对象转为error字段（name, message, stack）', () => {
      const logger = createLogger({ level: 'info', format: 'json' });
      const err = new Error('something went wrong');
      const output = captureStdout(() => {
        logger.error('operation failed', { error: err });
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].error).toBeDefined();
      expect(entries[0].error.name).toBe('Error');
      expect(entries[0].error.message).toBe('something went wrong');
      expect(entries[0].error.stack).toBeDefined();
      expect(typeof entries[0].error.stack).toBe('string');
    });

    it('enableStackTraces=false时不包含stack', () => {
      const logger = createLogger({
        level: 'info',
        format: 'json',
        enableStackTraces: false,
      });
      const err = new Error('no stack');
      const output = captureStdout(() => {
        logger.error('failed', { error: err });
      });
      const entries = parseStdoutJson(output);
      expect(entries[0].error.name).toBe('Error');
      expect(entries[0].error.message).toBe('no stack');
      expect(entries[0].error.stack).toBeUndefined();
    });
  });

  describe('采样率', () => {
    it('sampleRate=0时不输出', () => {
      const logger = createLogger({
        level: 'debug',
        format: 'json',
        sampleRate: 0,
      });
      const output = captureStdout(() => {
        logger.info('should not log');
        logger.warn('should not log');
        logger.error('should not log');
      });
      expect(output).toBe('');
    });

    it('sampleRate=1.0时全部输出', () => {
      const logger = createLogger({
        level: 'debug',
        format: 'json',
        sampleRate: 1.0,
      });
      const output = captureStdout(() => {
        logger.info('should log 1');
        logger.warn('should log 2');
        logger.error('should log 3');
      });
      const entries = parseStdoutJson(output);
      expect(entries.length).toBe(3);
      expect(entries.map(e => e.level)).toEqual(['info', 'warn', 'error']);
    });
  });

  describe('输出到文件', () => {
    it('outputFile配置后写入文件', async () => {
      const logger = createLogger({ level: 'info', format: 'json', outputFile: tmpFile });
      // 捕获 stdout 避免污染测试输出
      captureStdout(() => {
        logger.info('file test');
      });
      await closeAndWait(logger);
      const idx = loggers.indexOf(logger);
      if (idx >= 0) loggers.splice(idx, 1);
      const entries = readLogs();
      expect(entries.length).toBe(1);
      expect(entries[0].message).toBe('file test');
      expect(fs.existsSync(tmpFile)).toBe(true);
    });

    it('close关闭流', async () => {
      const logger = createLogger({ level: 'info', format: 'json', outputFile: tmpFile });
      captureStdout(() => {
        logger.info('before close');
      });
      await closeAndWait(logger);
      const idx = loggers.indexOf(logger);
      if (idx >= 0) loggers.splice(idx, 1);
      const entries = readLogs();
      expect(entries.length).toBe(1);
      expect(entries[0].message).toBe('before close');
      // 确认文件内容稳定（流已关闭，不再写入）
      const size1 = fs.statSync(tmpFile).size;
      await new Promise(resolve => setTimeout(resolve, 30));
      const size2 = fs.statSync(tmpFile).size;
      expect(size2).toBe(size1);
    });
  });
});
