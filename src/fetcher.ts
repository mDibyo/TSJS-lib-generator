import * as fs from "fs";
import * as path from "path";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";

fetchIDLs();

interface IDLSource {
    url: string;
    title: string;
    deprecated?: boolean;
}

async function fetchIDLs() {
    const idlSources = require("../inputfiles/idlSources.json") as IDLSource[];
    await Promise.all(idlSources.map(async source => {
        const { idl, comments } = await fetchIDL(source);
        fs.writeFileSync(path.join(__dirname, `../inputfiles/idl/${source.title}.widl`), idl + '\n');
        if (comments) {
            fs.writeFileSync(path.join(__dirname, `../inputfiles/idl/${source.title}.commentmap.json`), comments + '\n');
        }
    }));
}

async function fetchIDL(source: IDLSource) {
    const response = await fetch(source.url);
    const dom = JSDOM.fragment(await response.text());
    const elements = Array.from(dom.querySelectorAll("pre.idl:not(.extract),code.idl-code"));
    if (!elements.length) {
        throw new Error("Found no IDL code");
    }
    const last = elements[elements.length - 1];
    const idl = last.previousElementSibling && last.previousElementSibling.textContent!.includes("IDL Index")
        ? last.textContent!.trim()
        : elements.map(element => trimCommonIndentation(element.textContent!).trim()).join('\n\n');
    const comments = processComments(dom);
    return { idl, comments };
}

function processComments(dom: DocumentFragment) {
    const elements = Array.from(dom.querySelectorAll("dl.domintro"));
    if (!elements.length) {
        return undefined;
    }

    const result: Record<string, string> = {};
    for (const element of elements) {
        let child = element.firstElementChild;
        while (child) {
            const key = getKey(child.innerHTML);
            child = child.nextElementSibling;
            const childKey = child && getKey(child.innerHTML);
            if (key && child && (child === element.lastElementChild || !isNextKey(key, childKey))) {
                result[key] = getCommentText(child.textContent!);
                child = child.nextElementSibling;
            }
        }
    }
    return JSON.stringify(result, undefined, 4);
}

function isNextKey(k1: string, k2: string | null | undefined) {
    return k2 && k1.split("-")[0] === k2.split("-")[0];
}

function getKey(s: string) {
    const keyRegexp = /#dom-([a-zA-Z-_]+)/i;
    const match = s.match(keyRegexp);
    if (match) {
        return match[1];
    }
    return undefined;
}

function getCommentText(text: string) {
    return text
        .replace(/’/g, "'")
        .split("\n")
        .map(line => line.trim())
        .filter(line => !!line)
        .map(line => line.slice(getIndentation(line))).join("\n");
}

/**
 * Remove common indentation:
 *     <pre>
 *       typedef Type = "type";
 *       dictionary Dictionary {
 *         "member"
 *       };
 *     </pre>
 * Here the textContent has 6 common preceding whitespaces that can be unindented.
 */
function trimCommonIndentation(text: string) {
    const lines = text.split("\n");
    if (!lines[0].trim()) {
        lines.shift();
    }
    if (!lines[lines.length - 1].trim()) {
        lines.pop();
    }
    const commonIndentation = Math.min(...lines.map(getIndentation));
    return lines.map(line => line.slice(commonIndentation)).join("\n");
}

/** Count preceding whitespaces */
function getIndentation(line: string) {
    let count = 0;
    for (const ch of line) {
        if (ch !== " ") {
            break;
        }
        count++;
    }
    return count;
}
