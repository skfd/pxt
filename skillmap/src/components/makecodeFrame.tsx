/// <reference path="../../../built/pxteditor.d.ts" />
import * as React from "react";
import { connect } from 'react-redux';
import { saveProjectAsync, getProjectAsync } from "../lib/workspaceProvider";
import { isLocal, resolvePath, tickEvent } from "../lib/browserUtils";
import { lookupActivityProgress } from "../lib/skillMapUtils";

import { SkillMapState } from '../store/reducer';
import  { dispatchSetHeaderIdForActivity, dispatchCloseActivity, dispatchSaveAndCloseActivity, dispatchUpdateUserCompletedTags } from '../actions/dispatch';

/* tslint:disable:no-import-side-effect */
import '../styles/makecode-editor.css'
/* tslint:enable:no-import-side-effect */

interface MakeCodeFrameProps {
    save: boolean;
    mapId: string;
    activityId: string;
    title: string;
    url: string;
    tutorialPath: string;
    completed: boolean;
    activityHeaderId?: string;
    activityType: MapActivityType;
    dispatchSetHeaderIdForActivity: (mapId: string, activityId: string, id: string, currentStep: number, maxSteps: number, isCompleted: boolean) => void;
    dispatchCloseActivity: (finished?: boolean) => void;
    dispatchSaveAndCloseActivity: () => void;
    dispatchUpdateUserCompletedTags: () => void;
}

interface MakeCodeFrameState {
    loaded: boolean;

    // See handleFrameRef
    unloading: boolean;
}

/* tslint:disable:no-http-string */
export const editorUrl: string = isLocal() ? "http://localhost:3232/index.html" : (window as any).pxtTargetBundle.appTheme.embedUrl
/* tslint:enable:no-http-string */

class MakeCodeFrameImpl extends React.Component<MakeCodeFrameProps, MakeCodeFrameState> {
    protected ref: HTMLIFrameElement | undefined;
    protected messageQueue: any[] = [];
    protected finishedActivityState: "saving" | "finished" | undefined;
    protected nextId: number = 0;
    protected pendingMessages: {[index: string]: any} = {};

    constructor(props: MakeCodeFrameProps) {
        super(props);
        this.state = {
            loaded: false,
            unloading: false
        };
    }

    componentDidUpdate() {
        if (this.props.save) {
            this.sendMessage({
                type: "pxteditor",
                action: "saveproject",
                response: false
            } as pxt.editor.EditorMessage, true);
        }
    }

    componentWillUnmount() {
        window.removeEventListener("message", this.onMessageReceived);

        // Show Usabilla widget + footer
        setElementVisible(".usabilla_live_button_container", true);
        setElementVisible("footer", true);

        const root = document.getElementById("root");
        if (root) pxt.BrowserUtils.removeClass(root, "editor");
    }

    render() {
        const { url, title, save } = this.props;
        const { loaded, unloading } = this.state;

        const loadingText = save ? lf("Saving...") : lf("Loading...")
        const imageAlt = "MakeCode Logo";

        /* tslint:disable:react-iframe-missing-sandbox */
        return <div className="makecode-frame-outer">
            <div className={`makecode-frame-loader ${(loaded && !save) ? "hidden" : ""}`}>
                <img src={resolvePath("assets/logo.svg")} alt={imageAlt} />
                <div className="makecode-frame-loader-text">{loadingText}</div>
            </div>
            <iframe className="makecode-frame" src={unloading ? "about:blank" : url} title={title} ref={this.handleFrameRef}></iframe>
        </div>
        /* tslint:enable:react-iframe-missing-sandbox */
    }


    protected handleFrameRef = (ref: HTMLIFrameElement) => {
        if (ref && ref.contentWindow) {
            window.addEventListener("message", this.onMessageReceived);
            this.ref = ref;

            this.ref.addEventListener("load", () => {
                // This is a workaround for a bug in Chrome where for some reason the page hangs when
                // trying to unload the makecode iframe. Instead, we set the src to about:blank, wait for
                // that to load, and then unload the iframe
                if (this.state.unloading) {
                    this.props.dispatchCloseActivity(this.finishedActivityState === "finished");
                    this.props.dispatchUpdateUserCompletedTags();

                    this.finishedActivityState = undefined;
                }
            });

            // Hide Usabilla widget + footer when inside iframe view
            setElementVisible(".usabilla_live_button_container", false);
            setElementVisible("footer", false);

            const root = document.getElementById("root");
            if (root) pxt.BrowserUtils.addClass(root, "editor");
        }
    }

    protected onMessageReceived = (event: MessageEvent) => {
        const data = event.data as pxt.editor.EditorMessageRequest;

        if (data.type === "pxteditor" && data.id && this.pendingMessages[data.id]) {
            this.onResponseReceived(this.pendingMessages[data.id], event.data as pxt.editor.EditorMessageResponse);
            delete this.pendingMessages[data.id];
            return;
        }

        switch (data.action) {
            case "event":
                this.handleEditorTickEvent(data as pxt.editor.EditorMessageEventRequest);
                break;
            case "workspacesync":
                this.handleWorkspaceSyncRequest(data as pxt.editor.EditorWorkspaceSyncRequest);
                break;
            case "workspacesave":
                this.handleWorkspaceSaveRequestAsync(data as pxt.editor.EditorWorkspaceSaveRequest);
                break;
            case "workspaceevent":
                if ((data as pxt.editor.EditorWorkspaceEvent).event.type === "createproject") {
                    this.handleWorkspaceReadyEventAsync();
                }
                break;
            default:
                // console.log(JSON.stringify(data, null, 4));
        }
    }

    protected onResponseReceived(original: any, response: pxt.editor.EditorMessageResponse) {
        const { save } = this.props;

        if (original.action === "saveproject" && save) {
            if (this.finishedActivityState === "saving") {
                this.finishedActivityState = "finished";

                // Save again to be sure we get any final edits
                this.sendMessage({
                    type: "pxteditor",
                    action: "saveproject"
                } as pxt.editor.EditorMessage, true);
            }
            else {
                this.setState({
                    unloading: true
                });
            }
        }

        if (original.action === "importproject") {
            this.onEditorLoaded();
        }
    }

    protected sendMessage(message: any, response = false) {
        const sendMessageCore = (message: any) => {
            if (response) {
                message.response = true;
                message.id = this.nextId++ + "";
                this.pendingMessages[message.id] = message;
            }
            this.ref!.contentWindow!.postMessage(message, "*");
        }

        if (this.ref) {
            if (!this.ref.contentWindow) {
                this.messageQueue.push(message);
            }
            else {
                while (this.messageQueue.length) {
                    sendMessageCore(this.messageQueue.shift());
                }
                sendMessageCore(message);
            }
        }
    }

    protected handleWorkspaceSyncRequest(request: pxt.editor.EditorWorkspaceSyncRequest) {
        this.sendMessage({
            ...request,
            success: true,
            projects: []
        } as pxt.editor.EditorWorkspaceSyncResponse);
    }

    protected async handleWorkspaceSaveRequestAsync(request: pxt.editor.EditorWorkspaceSaveRequest) {
        const { dispatchSetHeaderIdForActivity, activityHeaderId, activityType, title, mapId, activityId } = this.props;

        const project = {
            ...request.project,
            header: {
                ...request.project.header!,
                id: activityHeaderId || request.project.header!.id
            }
        };

        // Patch the name, otherwise it will be the name of the GitHub repo
        if (project.header?.name !== title) {
            project.header!.name = title;
            const pxtJSON = project.text!["pxt.json"];
            if (pxtJSON) {
                const config = JSON.parse(pxtJSON);
                config.name = title;
                project.text!["pxt.json"] = pxt.Package.stringifyConfig(config);
            }
        }

        if (project.header.tutorialCompleted) {
            const existing = await getProjectAsync(project.header.id);

            if (existing?.header?.tutorial) {
                project.header.tutorial = existing.header.tutorial;
                project.header.tutorial.tutorialStep = project.header.tutorialCompleted.steps - 1;
                delete project.header.tutorialCompleted;
            }
        }

        if (activityType !== "tutorial" || project.header.tutorial || project.header.tutorialCompleted) {
            await saveProjectAsync(project);
        }

        if (project.header!.tutorial) {
            dispatchSetHeaderIdForActivity(
                mapId,
                activityId,
                project.header.id,
                (project.header.tutorial.tutorialStep || 0) + 1,
                project.header.tutorial.tutorialStepInfo!.length,
                false
            );
        }
        else if (project.header!.tutorialCompleted) {
            dispatchSetHeaderIdForActivity(
                mapId,
                activityId,
                project.header.id,
                project.header.tutorialCompleted.steps,
                project.header.tutorialCompleted.steps,
                true
            );
        }
    }

    protected async handleWorkspaceReadyEventAsync() {
        if (this.props.activityHeaderId) {
            const project = await getProjectAsync(this.props.activityHeaderId);
            this.sendMessage({
                type: "pxteditor",
                action: "importproject",
                project: project
            } as pxt.editor.EditorMessageImportProjectRequest, true)
        }
        else {
            this.sendMessage({
                type: "pxteditor",
                action: "startactivity",
                path: this.props.tutorialPath,
                activityType: "tutorial"
            } as pxt.editor.EditorMessageStartActivity, true);
        }
    }

    protected handleEditorTickEvent(event: pxt.editor.EditorMessageEventRequest) {
        switch (event.tick) {
            case "tutorial.editorLoaded":
                this.onEditorLoaded();
                break;
            case "tutorial.complete":
                this.onTutorialFinished();
                break;
        }
    }

    protected onEditorLoaded() {
        const { mapId, activityId } = this.props;
        tickEvent("skillmap.activity.loaded", { path: mapId, activity: activityId });
        this.setState({
            loaded: true
        });
    }

    protected onTutorialFinished() {
        const { mapId, activityId } = this.props;
        tickEvent("skillmap.activity.complete", { path: mapId, activity: activityId });
        this.finishedActivityState = "saving";
        this.props.dispatchSaveAndCloseActivity();
    }
}

function mapStateToProps(state: SkillMapState, ownProps: any) {
    if (!state || !state.editorView) return {};

    const { currentActivityId, currentMapId, currentHeaderId, state: saveState } = state.editorView;

    let url = editorUrl
    let title: string | undefined;

    const activity = state.maps[currentMapId].activities[currentActivityId];
    if (editorUrl.charAt(editorUrl.length - 1) === "/" && !isLocal()) {
        url = editorUrl.substr(0, editorUrl.length - 1);
    }

    url += `?controller=1&skillsMap=1&noproject=1&nocookiebanner=1`;
    title = activity.displayName;

    return {
        url,
        tutorialPath: activity.url,
        title,
        mapId: currentMapId,
        activityId: currentActivityId,
        activityHeaderId: currentHeaderId,
        completed: lookupActivityProgress(state.user, state.pageSourceUrl, currentMapId, currentActivityId)?.isCompleted,
        activityType: activity.type,
        save: saveState === "saving"
    }
}

function setElementVisible(selector: string, visible: boolean) {
    const el = document.querySelector(selector) as HTMLDivElement;
    if (el?.style) el.style.display = visible ? "" : "none";
}

const mapDispatchToProps = {
    dispatchSetHeaderIdForActivity,
    dispatchCloseActivity,
    dispatchSaveAndCloseActivity,
    dispatchUpdateUserCompletedTags
};

export const MakeCodeFrame = connect(mapStateToProps, mapDispatchToProps)(MakeCodeFrameImpl);