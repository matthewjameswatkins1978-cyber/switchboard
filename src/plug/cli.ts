import fs from 'node:fs';
import crypto from 'node:crypto';
import { SwitchboardPlug } from './switchboard-plug.js';
import { savePlugConfigFile, resolvePlugConfig } from './config.js';

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = args[0] || 'identify';
  const plug = new SwitchboardPlug();

  function getArg(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return undefined;
  }

  function hasFlag(flag: string): boolean {
    return args.includes(flag);
  }

  switch (command) {
    case 'identify':
    case 'id': {
      const info = plug.identify();
      console.log(JSON.stringify(info, null, 2));
      break;
    }

    case 'inbox': {
      const unreadOnly = hasFlag('--unread') || hasFlag('-u');
      const syncFirst = hasFlag('--sync') || hasFlag('-s');
      const limitStr = getArg('--limit') || getArg('-n');
      const limit = limitStr ? parseInt(limitStr, 10) : 32;

      const inbox = await plug.getInbox({ unreadOnly, limit, syncFirst });
      console.log(JSON.stringify(inbox, null, 2));
      break;
    }

    case 'read': {
      const id = args[1];
      if (!id || id.startsWith('-')) {
        console.error('Usage: sb read <message-id>');
        process.exit(1);
      }
      try {
        const msg = plug.readMessage(id);
        console.log(JSON.stringify(msg, null, 2));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'send': {
      const to = getArg('--to') || getArg('-t');
      const subject = getArg('--subject') || getArg('-s');
      const payloadStr = getArg('--payload') || getArg('-p') || '{}';
      const kind = getArg('--kind') || 'message.v1';
      const priority = (getArg('--priority') as any) || 'normal';
      const threadId = getArg('--thread-id');
      const replyToId = getArg('--reply-to');
      const immediate = hasFlag('--immediate') || hasFlag('-i');

      if (!to || !subject) {
        console.error('Usage: sb send --to <recipient> --subject "<subject>" --payload "<payload>" [--immediate]');
        process.exit(1);
      }

      let payload: unknown = payloadStr;
      try {
        payload = JSON.parse(payloadStr);
      } catch {
        // use string
      }

      try {
        const result = await plug.sendMessage({
          to,
          subject,
          payload,
          kind,
          priority,
          threadId,
          replyToId,
          immediate,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'reply': {
      const replyToId = getArg('--reply-to') || args[1];
      const subject = getArg('--subject') || getArg('-s');
      const payloadStr = getArg('--payload') || getArg('-p') || '{}';
      const kind = getArg('--kind');
      const priority = getArg('--priority') as any;
      const immediate = hasFlag('--immediate') || hasFlag('-i');

      if (!replyToId) {
        console.error('Usage: sb reply --reply-to <message-id> --payload "<payload>" [--subject "<subject>"]');
        process.exit(1);
      }

      let payload: unknown = payloadStr;
      try {
        payload = JSON.parse(payloadStr);
      } catch {
        // use string
      }

      try {
        const result = await plug.reply({
          replyToId,
          subject,
          payload,
          kind,
          priority,
          immediate,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'ack': {
      const messageId = getArg('--message-id') || args[1];
      const senderId = getArg('--sender-id');
      const note = getArg('--note');
      const immediate = hasFlag('--immediate') || hasFlag('-i');

      if (!messageId) {
        console.error('Usage: sb ack --message-id <id> [--sender-id <sender>] [--note "<note>"]');
        process.exit(1);
      }

      try {
        const result = await plug.acknowledge({
          messageId,
          senderId,
          note,
          immediate,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'sync': {
      try {
        const res = await plug.sync();
        console.log(JSON.stringify(res, null, 2));
      } catch (err) {
        console.error('Sync failed:', (err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      const state = (getArg('--state') || 'available') as any;
      const desc = getArg('--desc') || getArg('-d');
      const immediate = hasFlag('--immediate') || hasFlag('-i');

      try {
        await plug.updateStatus({ state, description: desc, immediate });
        console.log(JSON.stringify({ status: 'ok', state, description: desc }, null, 2));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'endpoints': {
      try {
        const endpoints = await plug.listEndpoints();
        console.log(JSON.stringify(endpoints, null, 2));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'board': {
      try {
        const board = await plug.getBoard();
        console.log(JSON.stringify(board, null, 2));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'daemon': {
      const stopAfterStr = getArg('--stop-after');
      const stopAfterMs = stopAfterStr ? parseInt(stopAfterStr, 10) * 1000 : undefined;

      console.log(`[Switchboard Daemon] Starting background sync for endpoint '${plug.config.endpointId}'...`);
      const controller = new AbortController();

      process.on('SIGINT', () => {
        console.log('\n[Switchboard Daemon] Stopping...');
        controller.abort();
      });
      process.on('SIGTERM', () => controller.abort());

      if (stopAfterMs) {
        setTimeout(() => {
          console.log(`[Switchboard Daemon] Auto-stopping after ${stopAfterStr}s`);
          controller.abort();
        }, stopAfterMs);
      }

      try {
        const stop = plug.startDaemon({
          stopSignal: controller.signal,
          onMessage: (msg) => {
            console.log(`[Switchboard Daemon] Received message ${msg.id} from ${msg.senderId}: "${msg.subject}"`);
          },
        });

        controller.signal.addEventListener('abort', () => {
          stop();
        });
      } catch (err) {
        console.error('Failed to start daemon:', (err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'config': {
      const sub = args[1] || 'show';
      if (sub === 'show') {
        const resolved = resolvePlugConfig();
        const tokenSha256 = resolved.token
          ? crypto.createHash('sha256').update(resolved.token).digest('hex')
          : undefined;
        const masked = {
          baseUrl: resolved.baseUrl,
          endpointId: resolved.endpointId,
          projectId: resolved.projectId,
          storagePath: resolved.storagePath,
          hasToken: resolved.hasToken,
          token: resolved.token ? '[REDACTED: 256-bit credential present]' : undefined,
          tokenSha256,
          configPath: resolved.configPath,
        };
        console.log(JSON.stringify(masked, null, 2));
      } else if (sub === 'set') {
        const key = args[2];
        let val = args[3];
        if (key === 'token' && (val === '--stdin' || hasFlag('--stdin'))) {
          try {
            val = fs.readFileSync(0, 'utf8').trim();
          } catch {
            console.error('Failed to read token from stdin.');
            process.exit(1);
          }
        } else if (key === 'token' && val) {
          console.warn(
            '[SECURITY NOTICE] Setting token via CLI arguments may expose secrets in process tables. Consider using stdin: sb config set token --stdin'
          );
        }
        if (!key || val === undefined) {
          console.error('Usage: sb config set <key> <value> (or sb config set token --stdin)');
          process.exit(1);
        }
        const savedPath = savePlugConfigFile({ [key]: val });
        console.log(`Saved configuration to ${savedPath}`);
      } else {
        console.error('Usage: sb config [show | set <key> <value>]');
        process.exit(1);
      }
      break;
    }

    default: {
      console.log(`Switchboard Universal Plug CLI
Usage: sb <command> [options]

Commands:
  identify                     Show local agent endpoint identity and state
  inbox [--unread] [--limit N] Query durable local inbox
  read <id>                    Read message body and mark as read
  send --to <recipient>        Send addressed message
  reply --reply-to <id>        Reply to message with thread correlation
  ack --message-id <id>        Acknowledge delivery
  sync                         Run immediate sync cycle
  status --state <state>       Update presence status
  endpoints                    List registered endpoints
  board                        Show board overview
  daemon [--stop-after <sec>]  Run background adaptive polling loop
  config [show | set <k> <v>]  View or edit local config
`);
      break;
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  runCli().catch((err) => {
    console.error('CLI Error:', err);
    process.exit(1);
  });
}
