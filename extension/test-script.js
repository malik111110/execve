const { renderStudioClientScript } = require('./out/ui/webview/studioClientScript');
const { renderStudioStyles } = require('./out/ui/styles/studioStyles');

try {
    console.log('Testing renderStudioClientScript...');
    const script = renderStudioClientScript('agent');
    
    // Check for backslashes
    const splitIndex = script.indexOf('.split(/');
    if (splitIndex !== -1) {
        const slice = script.substring(splitIndex, splitIndex + 20);
        console.log('Found split call:', JSON.stringify(slice));
    }

    try {
        // We know it might fail in Node because of webview globals, 
        // but "Invalid regular expression: missing /" is a syntax error that happens BEFORE execution.
        new Function('const acquireVsCodeApi = () => ({});' + script);
        console.log('renderStudioClientScript parsed successfully.');
    } catch (e) {
        console.error('renderStudioClientScript parsing failed:', e.message);
        // Find line number
        const lines = script.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('.split(/')) {
                 console.log(`Line ${i+1}: ${lines[i]}`);
            }
        }
    }

    console.log('Testing renderStudioStyles...');
    const styles = renderStudioStyles();
    const hasClosingStyle = styles.includes('</style>');
    const hasInterpolation = styles.includes('${');
    
    console.log('renderStudioStyles does not contain "</style>":', !hasClosingStyle);
    console.log('renderStudioStyles does not contain "${":', !hasInterpolation);

} catch (e) {
    console.error('Test failed with error:', e.message);
    process.exit(1);
}
