// 🧠 Caché local para evitar Error 429 de Rate Limit
const figmaCache = new Map<string, string>();

// ✂️ Limpiador de JSON para ahorrar tokens
function cleanFigmaNode(node: any): any {
    if (!node) return node;
    const cleanNode: any = { type: node.type, name: node.name };

    if (node.characters) cleanNode.characters = node.characters;
    if (node.fills && node.fills.length > 0) cleanNode.fills = node.fills;
    if (node.strokes && node.strokes.length > 0) cleanNode.strokes = node.strokes;
    if (node.strokeWeight) cleanNode.strokeWeight = node.strokeWeight;
    if (node.cornerRadius) cleanNode.cornerRadius = node.cornerRadius;
    if (node.layoutMode) cleanNode.layoutMode = node.layoutMode;
    if (node.itemSpacing) cleanNode.itemSpacing = node.itemSpacing;
    if (node.paddingTop) cleanNode.paddingTop = node.paddingTop;
    if (node.paddingBottom) cleanNode.paddingBottom = node.paddingBottom;
    if (node.paddingLeft) cleanNode.paddingLeft = node.paddingLeft;
    if (node.paddingRight) cleanNode.paddingRight = node.paddingRight;
    if (node.primaryAxisAlignItems) cleanNode.primaryAxisAlignItems = node.primaryAxisAlignItems;
    if (node.counterAxisAlignItems) cleanNode.counterAxisAlignItems = node.counterAxisAlignItems;
    
    if (node.style) {
        cleanNode.style = {
            fontFamily: node.style.fontFamily,
            fontWeight: node.style.fontWeight,
            fontSize: node.style.fontSize,
            lineHeightPx: node.style.lineHeightPx,
        };
    }

    if (node.children && Array.isArray(node.children)) {
        cleanNode.children = node.children.map(cleanFigmaNode);
    }
    return cleanNode;
}

export async function getFigmaContext(messageText: string): Promise<string | null> {
    const figmaRegex = /https:\/\/([\w.-]+\.)?figma.com\/(file|design)\/([a-zA-Z0-9]{22,128})(?:\/.*)?\?node-id=([a-zA-Z0-9%-]+)/;
    const match = messageText.match(figmaRegex);

    if (!match) return null; 

    const fileKey = match[3];
    let nodeId = match[4].replace('-', ':').replace('%3A', ':'); 

    if (figmaCache.has(nodeId)) {
        console.log(`⚡ Figma data loaded instantly from local cache!`);
        return figmaCache.get(nodeId) || null;
    }

    console.log(`🎨 Downloading node ${nodeId}...`);
    
    const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${nodeId}`, {
        headers: { 'X-Figma-Token': process.env.FIGMA_TOKEN as string }
    });
    
    if (!res.ok) throw new Error(`Figma API Error: ${await res.text()}`);
    
    const data = await res.json();
    if (!data.nodes || !data.nodes[nodeId]) throw new Error(`Node ${nodeId} not found.`);

    const rawNodeData = data.nodes[nodeId].document;
    const cleanData = cleanFigmaNode(rawNodeData);
    const jsonString = JSON.stringify(cleanData, null, 0); 
    
    figmaCache.set(nodeId, jsonString);
    return jsonString;
}