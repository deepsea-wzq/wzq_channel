const WebSocket = require('ws');

// 创建 WebSocket 服务器，监听端口 8080
const wss = new WebSocket.Server({ port: 12599 });

// 存储所有连接的客户端
const clients = new Set();

let isSend = false 

wss.on('connection', (ws) => {
  // 将新客户端加入集合
  clients.add(ws);
  console.log(`新客户端连接，当前连接数：${clients.size}`);

  // 监听客户端发送的消息
  ws.on('message', (message) => {
    console.log(`收到消息：${message}`);
  });

  // 监听连接关闭
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`客户端断开，当前连接数：${clients.size}`);
  });

  // 处理错误（防止服务器崩溃）
  ws.on('error', (error) => {
    console.error('WebSocket 错误：', error);
  });

  // 发送欢迎消息
  // ws.send(JSON.stringify({ "sessionId": "123456", "type": "text", "content":"你是谁"}));
});

console.log('WebSocket 服务器运行在 ws://localhost:12599');

const readline = require('readline');

// 创建一个interface来操作stdin和stdout
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('请输入一些内容（输入"exit"退出）：');

rl.on('line', (input) => {
  // 用户输入的内容存储在input变量中
  if (input.toLowerCase() === 'exit') {
    rl.close(); // 关闭接口并退出程序
  } else {
     clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        // 这里有问题，应该是client才对，怎么变成了websocket实例
	console.log('发送'+input)
        client.send(JSON.stringify({ "sessionId": "123456", "type": "text", "content":input }));
      }
    });
  }
});
