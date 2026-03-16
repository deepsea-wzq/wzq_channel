import type { RuntimeEnv } from "openclaw/plugin-sdk";
import WebSocket from "ws";
import type { ResolvedMyWsAccount } from "./accounts.js";
import { getMyWsRuntime } from "./runtime.js";
import {sendMyWsMessage} from "./send";

let isConn = false

/**
 * 活跃的 WebSocket 连接表，key 为 accountId
 * 供 send.ts 发送出站消息时使用
 */
const activeConnections = new Map<string, WebSocket>();

export function getActiveWs(accountId: string): WebSocket | undefined {
  return activeConnections.get(accountId);
}

export type MonitorOptions = {
  account: ResolvedMyWsAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink: (patch: Record<string, unknown>) => void;
  cfg: unknown;
};

/**
 * 启动 WebSocket 长连接监听，入站消息通过 runtime.channel.inbound.dispatch 分发给 agent。
 * 返回 { stop } 供 gateway 在 abort 时调用。
 */
export async function startMyWsMonitor(opts: MonitorOptions): Promise<{ stop: () => void }> {

  if (isConn) {
    console.log("只创建一个链接")
    return
  }

  const { account, runtime, abortSignal, statusSink, cfg } = opts;
  const core = getMyWsRuntime();
  const logger = core.logging.getChildLogger({
    channel: "wzq-channel",
    accountId: account.accountId,
  });

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 心跳保活 ──────────────────────────────────────────────────────────────
  // 每隔 HEARTBEAT_INTERVAL 毫秒发送一次 ping；
  // 若在 HEARTBEAT_TIMEOUT 毫秒内未收到 pong，则主动关闭连接触发重连。
  const HEARTBEAT_INTERVAL = 30_000; // 30 秒发一次 ping
  const HEARTBEAT_TIMEOUT  = 10_000; // 10 秒内必须收到 pong

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingForPong = false;

  function clearHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (pongTimeoutTimer !== null) {
      clearTimeout(pongTimeoutTimer);
      pongTimeoutTimer = null;
    }
    waitingForPong = false;
  }

  function startHeartbeat(socket: WebSocket) {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        console.log('socket readystate no open')
        clearHeartbeat();
        return;
      }
      if (waitingForPong) {
        // 上一次 ping 还没收到 pong，连接可能已僵死
        logger.warn?.(`[${account.accountId}] 心跳超时，主动断开连接并重连`);
        clearHeartbeat();
        socket.terminate(); // 强制关闭，触发 close 事件 → 重连
        return;
      }
      waitingForPong = true;
      socket.ping();
      console.log('socket send pin')
      // 启动 pong 超时计时器
      pongTimeoutTimer = setTimeout(() => {
        if (waitingForPong) {
          logger.warn?.(`[${account.accountId}] pong 响应超时，主动断开连接并重连`);
          clearHeartbeat();
          socket.terminate();
        }
      }, HEARTBEAT_TIMEOUT);
    }, HEARTBEAT_INTERVAL);
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connect() {
    if (stopped || abortSignal.aborted) return;

    logger.info(`[${account.accountId}] 正在连接 WebSocket: ${account.wsUrl}`);

    ws = new WebSocket(account.wsUrl, {
      headers: account.token ? { Authorization: `Bearer ${account.token}` } : {},
    });

    ws.on("open", () => {
      logger.info(`[${account.accountId}] WebSocket 连接已建立`);
      activeConnections.set(account.accountId, ws!);
      statusSink({ running: true, lastError: null });
      // 连接建立后启动心跳
      startHeartbeat(ws!);
      isConn = true;
    });

    ws.on("pong", () => {
      // 收到服务器 pong，清除超时计时器，标记已响应
      console.log("socket get pong")
      if (pongTimeoutTimer !== null) {
        clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = null;
      }
      waitingForPong = false;
    });

    ws.on("message", async (data) => {
      try {
        // 记录入站活动
        core.channel.activity.record({
          channel: "wzq-channel",
          accountId: account.accountId,
          direction: "inbound",
          at: Date.now(),
        });
        statusSink({ lastInboundAt: Date.now() });

        // 解析服务器推送的消息
        // 期望格式：{session_id,content_type,content}
        // 可根据实际服务器协议调整此处的字段映射
        const msg = JSON.parse(String(data)) as {
          session_id?: string;
          content_type?: string;
          content?: string;
        };

        if (!msg.content || !msg.session_id) {
          logger.warn?.(`[${account.accountId}] 收到格式不符的消息，已忽略: ${String(data)}`);
          return;
        }

        console.log("send message" + msg.content);

        const session_id = msg.session_id // Date.now().toString()
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "wzq-channel",
          accountId: account.accountId,
          peer: {
            kind: "dm",
            id: session_id,
          },
        });
        const bodyText = msg.content;
        const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
        const body = core.channel.reply.formatInboundEnvelope({
          channel: "wzq-channel",
          from: account.accountId,
          timestamp: Date.now(),
          body: bodyText,
          chatType: "direct",
          sender: { id: session_id },
          envelope: envelopeOptions,
        });

        const address = `wzq-channel:${session_id}`;
        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: msg.content,
          CommandBody: bodyText,
          From: address,
          To: address,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "direct",
          SenderId: session_id,
          Provider: "wzq-channel",
          Surface: "wzq-channel",
          MessageSid: Date.now().toString(),  // 消息id不能重
          Timestamp: Date.now(),
          OriginatingChannel: "wzq-channel",
          OriginatingTo: address,
        });

        console.log('结构完成')

        try {
          const messagesConfig = core.channel.reply.resolveEffectiveMessagesConfig(
            cfg,
            route.agentId,
          );
          console.log("执行ai调用")
          await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,

              deliver: async (
                payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
                _info?: { kind?: string },
              ) => {
                console.log("ai调用回复")

                const text = payload.text ?? "";

                console.log(JSON.stringify(payload))

                // 发送信息
                const result = await sendMyWsMessage({
                  accountId: account.accountId,
                  to: address,
                  text: text,
                });
                console.log("发送信息返回结果是")
                console.log(result)
              },
              onError: (err: unknown) => {
                console.log("AI dispatch onerror")
                console.log(err)
              },
            },
            replyOptions: {},
          });
          console.log("整段代码执行完毕")
        } catch (err) {
          console.log('catech exception')
          console.log(err)
        }
      } catch (err) {
        logger.error(`[${account.accountId}] 处理入站消息失败: ${String(err)}`);
        statusSink({ lastError: String(err) });
      }
    });

    ws.on("error", (err) => {
      logger.error(`[${account.accountId}] WebSocket 错误: ${err.message}`);
      statusSink({ lastError: err.message });
    });

    ws.on("close", (code, reason) => {
      clearHeartbeat(); // 连接关闭时停止心跳
      activeConnections.delete(account.accountId);
      logger.info(
        `[${account.accountId}] WebSocket 连接已关闭 (code=${code}, reason=${String(reason)})`,
      );
      if (!stopped && !abortSignal.aborted) {
        // 3 秒后自动重连
        reconnectTimer = setTimeout(connect, 3000);
      }
    });
  }

  connect();

  abortSignal.addEventListener(
    "abort",
    () => {
      stopped = true;
      clearHeartbeat();
      clearReconnectTimer();
      activeConnections.delete(account.accountId);
      ws?.close();
    },
    { once: true },
  );

  return {
    stop: () => {
      stopped = true;
      clearHeartbeat();
      clearReconnectTimer();
      activeConnections.delete(account.accountId);
      ws?.close();
    },
  };
}
