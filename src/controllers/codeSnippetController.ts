import { EOL } from 'os';
import * as url from 'url';
import { Clipboard, env, QuickInputButtons, QuickPickItem, window } from 'vscode';
import { logger } from '../logger';
import { HARCookie, HARHeader, HARHttpRequest, HARPostData } from '../models/harHttpRequest';
import { HttpRequest } from '../models/httpRequest';
import { RequestParserFactory } from '../models/requestParserFactory';
import { trace } from "../utils/decorator";
import { base64 } from '../utils/misc';
import { Selector } from '../utils/selector';
import { Telemetry } from '../utils/telemetry';
import { getCurrentTextDocument } from '../utils/workspaceUtility';
import { CodeSnippetWebview } from '../views/codeSnippetWebview';

const encodeUrl = require('encodeurl');
const HTTPSnippet = require('httpsnippet');

interface CodeSnippetTargetQuickPickItem extends QuickPickItem {
    target: {
        key: string;
        title: string;
        clients: [{
            title: string;
            link: string,
            description: string
        }]
    };
}

interface CodeSnippetClientQuickPickItem extends CodeSnippetTargetQuickPickItem {
    client: {
        key: string;
        title: string;
    };
}

export class CodeSnippetController {
    private static _availableTargets = HTTPSnippet.availableTargets();
    private readonly clipboard: Clipboard;
    private _convertedResult;
    private _webview: CodeSnippetWebview;

    constructor() {
        this._webview = new CodeSnippetWebview();
        this.clipboard = env.clipboard;
    }

    public async run() {
        const editor = window.activeTextEditor;
        const document = getCurrentTextDocument();
        if (!editor || !document) {
            return;
        }

        const selectedRequest = await Selector.getRequest(editor);
        if (!selectedRequest) {
            return;
        }

        const { text } = selectedRequest;

        // parse http request
        const httpRequest = new RequestParserFactory().createRequestParser(text).parseHttpRequest(document.fileName);

        const harHttpRequest = this.convertToHARHttpRequest(httpRequest);
        const snippet = new HTTPSnippet(harHttpRequest);

        if (CodeSnippetController._availableTargets) {
            const quickPick = window.createQuickPick();
            const targetQuickPickItems: CodeSnippetTargetQuickPickItem[] = CodeSnippetController._availableTargets.map(target => ({ label: target.title, target }));
            quickPick.title = 'Generate Code Snippet';
            quickPick.step = 1;
            quickPick.totalSteps = 2;
            quickPick.items = targetQuickPickItems;
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;
            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.onDidTriggerButton(() => {
                quickPick.step!--;
                quickPick.buttons = [];
                quickPick.items = targetQuickPickItems;
            });
            quickPick.onDidAccept(() => {
                const selectedItem = quickPick.selectedItems[0];
                if (selectedItem) {
                    if (quickPick.step === 1) {
                        quickPick.step++;
                        quickPick.buttons = [QuickInputButtons.Back];
                        const targetItem = selectedItem as CodeSnippetTargetQuickPickItem;
                        quickPick.items = targetItem.target.clients.map(
                            client => ({
                                label: client.title,
                                description: client.description,
                                detail: client.link,
                                target: targetItem.target,
                                client
                            })
                        );
                    } else if (quickPick.step === 2) {
                        const { target: { key: tk, title: tt }, client: { key: ck, title: ct } } = (selectedItem as CodeSnippetClientQuickPickItem);
                        Telemetry.sendEvent('Generate Code Snippet', { 'target': tk, 'client': ck });
                        const result = snippet.convert(tk, ck);
                        this._convertedResult = result;

                        try {
                            this._webview.render(result, `${tt}-${ct}`, tk);
                        } catch (reason) {
                            logger.error('Unable to preview generated code snippet:', reason);
                            window.showErrorMessage(reason);
                        }
                    }
                }
            });
            quickPick.show();
        } else {
            window.showInformationMessage('No available code snippet convert targets');
        }
    }

    @trace('Copy Code Snippet')
    public async copy() {
        if (this._convertedResult) {
            await this.clipboard.writeText(this._convertedResult);
        }
    }

    @trace('Copy Request As cURL')
    public async copyAsCurl() {
        const editor = window.activeTextEditor;
        const document = getCurrentTextDocument();
        if (!editor || !document) {
            return;
        }

        const selectedRequest = await Selector.getRequest(editor);
        if (!selectedRequest) {
            return;
        }

        const { text } = selectedRequest;

        // parse http request
        const httpRequest = new RequestParserFactory().createRequestParser(text).parseHttpRequest(document.fileName);

        const harHttpRequest = this.convertToHARHttpRequest(httpRequest);
        const addPrefix = !(url.parse(harHttpRequest.url).protocol);
        const originalUrl = harHttpRequest.url;
        if (addPrefix) {
            // Add protocol for url that doesn't specify protocol to pass the HTTPSnippet validation #328
            harHttpRequest.url = `http://${originalUrl}`;
        }
        const snippet = new HTTPSnippet(harHttpRequest);
        if (addPrefix) {
            snippet.requests[0].fullUrl = originalUrl;
        }
        const result = snippet.convert('shell', 'curl', process.platform === 'win32' ? { indent: false } : {});
        await this.clipboard.writeText(result);
    }

    private convertToHARHttpRequest(request: HttpRequest): HARHttpRequest {
        // convert headers
        const headers: HARHeader[] = [];
        for (const key in request.headers) {
            const headerValue = request.headers[key];
            if (!headerValue) {
                continue;
            }
            const headerValues = Array.isArray(headerValue) ? headerValue : [headerValue.toString()];
            for (let value of headerValues) {
                if (key.toLowerCase() === 'authorization') {
                    value = CodeSnippetController.normalizeAuthHeader(value);
                }
                headers.push(new HARHeader(key, value));
            }
        }

        // convert cookie headers
        const cookies: HARCookie[] = [];
        const cookieHeader = headers.find(header => header.name.toLowerCase() === 'cookie');
        if (cookieHeader) {
            cookieHeader.value.split(';').forEach(pair => {
                const [headerName, headerValue = ''] = pair.split('=', 2);
                cookies.push(new HARCookie(headerName.trim(), headerValue.trim()));
            });
        }

        // convert body
        let body: HARPostData | undefined;
        if (request.body) {
            const contentTypeHeader = headers.find(header => header.name.toLowerCase() === 'content-type');
            const mimeType: string = contentTypeHeader?.value ?? 'application/json';
            if (typeof request.body === 'string') {
                const normalizedBody = request.body.split(EOL).reduce((prev, cur) => prev.concat(cur.trim()), '');
                body = new HARPostData(mimeType, normalizedBody);
            } else {
                body = new HARPostData(mimeType, request.rawBody!);
            }
        }

        return new HARHttpRequest(request.method, encodeUrl(request.url), headers, cookies, body);
    }

    public dispose() {
        this._webview.dispose();
    }

    private static normalizeAuthHeader(authHeader: string) {
        if (authHeader) {
            const start = authHeader.indexOf(' ');
            const scheme = authHeader.substr(0, start);
            if (scheme.toLowerCase() === 'basic') {
                const params = authHeader.substr(start).trim().split(' ');
                if (params.length === 2) {
                    return `Basic ${base64(`${params[0]}:${params[1]}`)}`;
                }
            }
        }

        return authHeader;
    }
}