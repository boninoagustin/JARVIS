const fs = require('fs');
const file = 'src/agent/loop.ts';
let code = fs.readFileSync(file, 'utf8');
const search = "ESTÁS EQUIPADO CON HERRAMIENTAS DE N8N (MCP). Si el usuario te pide crear, listar, borrar o modificar workflows o nodos de n8n, DEBES usar las herramientas que empiezan con 'n8n_' o herramientas de búsqueda de nodos/templates como 'search_nodes'. NO intentes usar 'execute_terminal_command' para tareas de n8n a menos que sea estrictamente necesario. Tienes permisos completos para gestionar la instancia de n8n local a través de estas herramientas.";
const replace = "ESTÁS EQUIPADO CON HERRAMIENTAS MCP DE N8N Y TRADINGVIEW. Si el usuario pide un pantallazo, diagrama o gráfico de TradingView, DEBES usar PRIMERO 'capture_screenshot'. Esa herramienta te devolverá un JSON con el 'file_path'. LUEGO, para que el usuario reciba la imagen, DEBES llamar OBLIGATORIAMENTE a 'send_telegram_document' pasándole ese file_path. Para flujos de n8n, usa herramientas como 'search_nodes' o 'n8n_'.";
if(code.includes(search)) {
  code = code.replace(search, replace);
  fs.writeFileSync(file, code);
  console.log("Updated successfully");
} else {
  console.log("String not found!");
}
